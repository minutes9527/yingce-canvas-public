package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"yingce/backend/internal/model"
)

const frameScriptConfigSettingKey = "plugin.framescript.config"

type FrameScriptConfig struct {
	ChannelID              string  `json:"channelId"`
	TranscriptionChannelID string  `json:"transcriptionChannelId"`
	VisionModel            string  `json:"visionModel"`
	PromptModel            string  `json:"promptModel"`
	TranscriptionModel     string  `json:"transcriptionModel"`
	ChangeThreshold        float64 `json:"changeThreshold"`
	SamplingIntervalMs     int     `json:"samplingIntervalMs"`
}

func (s *Service) FrameScriptConfig(actor *model.User) (*FrameScriptConfig, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, Forbidden("请先登录")
	}
	setting, err := s.repo.SystemSettingOptional(frameScriptConfigSettingKey)
	if err != nil {
		return nil, fmt.Errorf("读取视频拆解配置：%w", err)
	}
	if setting == nil {
		return nil, nil
	}
	var config FrameScriptConfig
	if err := json.Unmarshal([]byte(setting.ValueJSON), &config); err != nil {
		return nil, fmt.Errorf("视频拆解配置格式无效：%w", err)
	}
	return &config, nil
}

func (s *Service) FrameScriptRuntimeConfig(actor *model.User) (*FrameScriptConfig, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, Forbidden("请先登录")
	}
	if err := s.RequirePluginForUser(actor.ID, PluginFrameScriptVideo); err != nil {
		return nil, err
	}
	config, err := s.FrameScriptConfig(actor)
	if err != nil {
		return nil, err
	}
	if config == nil {
		return nil, NewAppError(503, "管理员尚未配置视频拆解")
	}
	if err := s.validateFrameScriptConfigModels(config); err != nil {
		return nil, err
	}
	return config, nil
}

func (s *Service) SaveFrameScriptConfig(actor *model.User, config FrameScriptConfig) (*FrameScriptConfig, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	config.ChannelID = strings.TrimSpace(config.ChannelID)
	config.TranscriptionChannelID = strings.TrimSpace(config.TranscriptionChannelID)
	config.VisionModel = strings.TrimSpace(config.VisionModel)
	config.PromptModel = strings.TrimSpace(config.PromptModel)
	config.TranscriptionModel = strings.TrimSpace(config.TranscriptionModel)
	if config.ChannelID == "" || config.VisionModel == "" || config.PromptModel == "" || config.TranscriptionModel == "" {
		return nil, NewAppError(400, "请选择视频拆解的渠道和三个模型")
	}
	if config.ChangeThreshold < 0.01 || config.ChangeThreshold > 1 || config.SamplingIntervalMs < 100 || config.SamplingIntervalMs > 2000 {
		return nil, NewAppError(400, "视频拆解采样参数超出范围")
	}
	if err := s.validateFrameScriptConfigModels(&config); err != nil {
		return nil, err
	}
	data, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	setting, err := s.repo.SystemSettingOptional(frameScriptConfigSettingKey)
	if err != nil {
		return nil, fmt.Errorf("读取视频拆解旧配置：%w", err)
	}
	if setting == nil {
		setting = &model.SystemSetting{Key: frameScriptConfigSettingKey, CreatedAt: now}
	}
	setting.ValueJSON, setting.UpdatedBy, setting.UpdatedAt = string(data), actor.ID, now
	if err := s.repo.SaveSystemSetting(setting); err != nil {
		return nil, fmt.Errorf("保存视频拆解配置：%w", err)
	}
	if err := s.appendAdminAudit(actor, "plugin.framescript.config.update", "plugin", PluginFrameScriptVideo, "更新视频拆解模型配置", map[string]any{"channelId": config.ChannelID, "transcriptionChannelId": config.TranscriptionChannelID}); err != nil {
		return nil, err
	}
	return &config, nil
}

func (s *Service) validateFrameScriptConfigModels(config *FrameScriptConfig) error {
	if err := s.validateFrameScriptModel(config.ChannelID, config.VisionModel, "画面分析"); err != nil {
		return err
	}
	if err := s.validateFrameScriptModel(config.ChannelID, config.PromptModel, "图片提示词"); err != nil {
		return err
	}
	channelID := config.TranscriptionChannelID
	if channelID == "" {
		channelID = config.ChannelID
	}
	return s.validateFrameScriptModel(channelID, config.TranscriptionModel, "语音转写")
}

func (s *Service) validateFrameScriptModel(channelID, modelKey, purpose string) error {
	if _, err := s.repo.SystemChannel(channelID); err != nil {
		return NewAppError(400, purpose+"渠道不存在或未启用")
	}
	models, err := s.repo.ChannelModels(channelID, false)
	if err != nil {
		return fmt.Errorf("读取%s模型：%w", purpose, err)
	}
	for _, item := range models {
		if item.ModelKey != modelKey {
			continue
		}
		if !item.PriceConfigured {
			return NewAppError(400, purpose+"模型尚未配置价格")
		}
		if !frameScriptSupportsPurpose(item, purpose) {
			return NewAppError(400, purpose+"模型不支持所需输入类型")
		}
		for _, tier := range item.PriceTiers {
			if tier.Enabled && tier.PriceConfigured {
				return nil
			}
		}
		return NewAppError(400, purpose+"模型没有可用价格档")
	}
	return NewAppError(400, purpose+"模型不属于所选渠道或未启用")
}

func frameScriptSupportsPurpose(item model.ChannelModel, purpose string) bool {
	key := strings.ToLower(item.ModelKey)
	switch purpose {
	case "语音转写":
		return item.Protocol == model.ChannelInterfaceOpenAIAudio ||
			strings.Contains(key, "asr") || strings.Contains(key, "whisper") ||
			strings.Contains(key, "transcri") || strings.HasPrefix(key, "qwen3.5-omni-")
	case "画面分析", "图片提示词":
		if item.Capability != "text" {
			return false
		}
		config, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
		if err == nil && config != nil && config.Text != nil && config.Text.References.MaxImages > 0 {
			return true
		}
		return strings.Contains(key, "-vl") || strings.Contains(key, "vision") || strings.Contains(key, "omni")
	default:
		return item.Capability == "text"
	}
}
