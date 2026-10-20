package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"yingce/backend/internal/app"
	"yingce/backend/internal/assets"
	"yingce/backend/internal/database"
	"yingce/backend/internal/repository"
)

func main() {
	var resourceID string
	var all bool
	var apply bool
	var verifyID string
	var playback bool
	var skipPlayback bool
	flag.StringVar(&resourceID, "id", "", "migrate one resource ID")
	flag.BoolVar(&all, "all", false, "migrate every ready local resource")
	flag.BoolVar(&apply, "apply", false, "copy and switch verified resources; default is dry run")
	flag.StringVar(&verifyID, "verify-id", "", "verify signed browser read for a switched resource")
	flag.BoolVar(&playback, "playback", false, "verify the browser-compatible video variant")
	flag.BoolVar(&skipPlayback, "skip-playback", false, "leave resources with ready playback copies on local storage")
	flag.Parse()
	if countSelected(resourceID, all, verifyID) != 1 {
		log.Fatal("specify exactly one of -id, -all, or -verify-id")
	}
	dataDir := os.Getenv("CANVAS_BACKEND_DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	db, err := database.Open(database.Config{Driver: os.Getenv("CANVAS_DATABASE_DRIVER"), DSN: os.Getenv("DATABASE_URL"), DataDir: dataDir})
	if err != nil {
		log.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		log.Fatal(err)
	}
	defer sqlDB.Close()
	svc := app.New(repository.New(db), dataDir)
	defer svc.Close()
	if verifyID != "" {
		if err := verifyBrowserRead(svc, repository.New(db), verifyID, playback); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("BROWSER_READ_OK %s playback=%t\n", verifyID, playback)
		return
	}
	var ids []string
	if all {
		resources, err := svc.ReadyLocalResources()
		if err != nil {
			log.Fatal(err)
		}
		for _, resource := range resources {
			if skipPlayback && resource.PlaybackStatus == "ready" && resource.PlaybackObjectKey != "" {
				continue
			}
			ids = append(ids, resource.ID)
		}
	} else {
		ids = []string{resourceID}
	}
	var failed int
	var switched int
	var bytes int64
	for _, id := range ids {
		result, err := svc.MigrateLocalResourceToActiveOSS(id, !apply)
		if err != nil {
			fmt.Fprintf(os.Stderr, "FAILED %s: %v\n", id, err)
			failed++
			continue
		}
		bytes += result.OriginalBytes + result.PlaybackBytes
		if result.Switched {
			switched++
		}
		fmt.Printf("%s %s original=%d playback=%d\n", map[bool]string{true: "SWITCHED", false: "READY"}[result.Switched], id, result.OriginalBytes, result.PlaybackBytes)
	}
	fmt.Printf("SUMMARY total=%d switched=%d failed=%d bytes=%d apply=%t\n", len(ids), switched, failed, bytes, apply)
	if failed > 0 {
		os.Exit(1)
	}
}

func countSelected(id string, all bool, verifyID string) int {
	count := 0
	if strings.TrimSpace(id) != "" {
		count++
	}
	if all {
		count++
	}
	if strings.TrimSpace(verifyID) != "" {
		count++
	}
	return count
}

func verifyBrowserRead(svc *app.Service, repo *repository.Repository, id string, playback bool) error {
	resource, err := repo.Resource(id)
	if err != nil {
		return err
	}
	variant := assets.VariantOriginal
	if playback {
		variant = assets.VariantPlayback
	}
	results, err := svc.ResourceAccessBatch(resource.UserID, []app.ResourceAccessRequest{{ResourceID: id, AccessOptions: assets.AccessOptions{Purpose: assets.PurposeDisplay, Variant: variant}}})
	if err != nil {
		return err
	}
	if len(results) != 1 || results[0].Error != nil || results[0].Access == nil {
		return fmt.Errorf("资源签名地址不可用：%s", id)
	}
	access := results[0].Access
	if access.ActualVariant != variant {
		return fmt.Errorf("资源变体回退：%s", id)
	}
	req, err := http.NewRequest(http.MethodGet, access.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Origin", "https://min99.cc")
	req.Header.Set("Range", "bytes=0-0")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("浏览器直连失败：%w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	if resp.StatusCode != http.StatusPartialContent || resp.Header.Get("Access-Control-Allow-Origin") != "https://min99.cc" {
		return fmt.Errorf("浏览器直连返回异常：status=%d, cors=%q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
	return nil
}
