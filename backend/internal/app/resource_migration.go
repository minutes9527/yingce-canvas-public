package app

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"yingce/backend/internal/model"
)

type LocalResourceMigrationResult struct {
	ID            string
	OriginalBytes int64
	PlaybackBytes int64
	Switched      bool
}

func (s *Service) ReadyLocalResources() ([]model.Resource, error) {
	return s.repo.ReadyLocalResources()
}

// MigrateLocalResourceToActiveOSS keeps the source files intact. A database row
// is switched only after every required remote object has been read back and
// compared byte-for-byte by SHA-256.
func (s *Service) MigrateLocalResourceToActiveOSS(resourceID string, dryRun bool) (LocalResourceMigrationResult, error) {
	result := LocalResourceMigrationResult{ID: resourceID}
	resource, err := s.repo.Resource(resourceID)
	if err != nil {
		return result, err
	}
	if resource.Provider != "local" || resource.Status != model.ResourceStatusReady {
		return result, errors.New("资源已不在待迁移状态")
	}
	setting, err := s.activeOSSSetting()
	if err != nil {
		return result, err
	}
	if setting.Provider != s3Provider || setting.StorageLocationID == "" {
		return result, errors.New("需要已测试并保存的 S3 存储位置")
	}
	setting = s.storageSettingWithRuntimePolicy(setting)
	originalPath, err := migrationSourcePath(s.dataDir, "resources", resource.ObjectKey)
	if err != nil {
		return result, err
	}
	result.OriginalBytes, err = migrationFileSize(originalPath)
	if err != nil {
		return result, err
	}
	if result.OriginalBytes != resource.Size {
		return result, fmt.Errorf("本地原件大小与数据库不符：%s", resource.ID)
	}
	playbackKey := resource.PlaybackObjectKey
	var playbackPath string
	if resource.PlaybackStatus == model.PlaybackStatusReady {
		if playbackKey == "" {
			return result, errors.New("就绪的播放副本缺少文件名")
		}
		playbackPath, err = migrationSourcePath(s.dataDir, playbackDirName, playbackKey)
		if err != nil {
			return result, err
		}
		result.PlaybackBytes, err = migrationFileSize(playbackPath)
		if err != nil {
			return result, err
		}
		playbackKey = "playback/" + filepath.Base(playbackKey)
	}
	if dryRun {
		return result, nil
	}
	etag, err := migrationCopyAndVerify(setting, originalPath, resource.ObjectKey, resource.MimeType, result.OriginalBytes)
	if err != nil {
		return result, err
	}
	if playbackPath != "" {
		if _, err := migrationCopyAndVerify(setting, playbackPath, playbackKey, "video/mp4", result.PlaybackBytes); err != nil {
			return result, err
		}
	}
	result.Switched, err = s.repo.SwitchLocalResourceToOSS(resource, setting.Provider, setting.Endpoint, setting.Bucket, setting.StorageLocationID, etag, playbackKey)
	if err != nil {
		return result, err
	}
	if !result.Switched {
		return result, errors.New("迁移期间资源已变化，数据库未切换")
	}
	return result, nil
}

func migrationSourcePath(dataDir, directory, key string) (string, error) {
	if key == "" || strings.Contains(key, "\\") || filepath.IsAbs(key) {
		return "", errors.New("本地对象键无效")
	}
	root := filepath.Join(dataDir, directory)
	clean := filepath.Clean(filepath.FromSlash(key))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("本地对象键越界")
	}
	return filepath.Join(root, clean), nil
}

func migrationFileSize(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 {
		return 0, errors.New("迁移源文件不是非空普通文件")
	}
	return info.Size(), nil
}

func migrationCopyAndVerify(setting ossSettingValue, path, key, mimeType string, size int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	localHash := sha256.New()
	read, err := io.Copy(localHash, file)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return "", fmt.Errorf("读取迁移源文件失败：%w", errors.Join(err, closeErr))
	}
	if read != size {
		return "", fmt.Errorf("迁移源文件长度发生变化：%d/%d", read, size)
	}
	file, err = os.Open(path)
	if err != nil {
		return "", err
	}
	etag, uploadErr := putOSSObject(setting, key, mimeType, size, file)
	closeErr = file.Close()
	if uploadErr != nil || closeErr != nil {
		return "", fmt.Errorf("复制对象失败：%w", errors.Join(uploadErr, closeErr))
	}
	stream, err := getOriginOSSObjectRange(setting, key, "")
	if err != nil {
		return "", fmt.Errorf("回读对象失败：%w", err)
	}
	remoteHash := sha256.New()
	remoteBytes, readErr := io.Copy(remoteHash, stream.Body)
	closeErr = stream.Body.Close()
	if readErr != nil || closeErr != nil || remoteBytes != size || string(remoteHash.Sum(nil)) != string(localHash.Sum(nil)) {
		return "", fmt.Errorf("对象回读校验失败：key=%s, bytes=%d/%d, read=%v, close=%v", key, remoteBytes, size, readErr, closeErr)
	}
	return etag, nil
}
