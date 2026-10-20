package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizedFrameScriptIntervalCapsSampleCount(t *testing.T) {
	if got := normalizedFrameScriptInterval(400, 47_000); got != 400 {
		t.Fatalf("short video interval = %d, want 400", got)
	}
	if got := normalizedFrameScriptInterval(400, 900_000); got != 5_625 {
		t.Fatalf("long video interval = %d, want 5625", got)
	}
	if got := normalizedFrameScriptInterval(10, 1_000); got != 100 {
		t.Fatalf("lower bound interval = %d, want 100", got)
	}
}

func TestFrameScriptCandidatePriorityPrefersQualityWhenChangeIsEqual(t *testing.T) {
	sharp := frameScriptSample{difference: .2, quality: .9}
	blurry := frameScriptSample{difference: .2, quality: .1}
	if frameScriptCandidatePriority(sharp) <= frameScriptCandidatePriority(blurry) {
		t.Fatal("quality must affect candidate ranking")
	}
}

func TestResolveFrameScriptTemporalSignalsSuppressesFlashAndFindsGradualTransition(t *testing.T) {
	samples := []frameScriptSample{
		{difference: 0},
		{difference: .7},
		{difference: .7, twoStepDifference: .1}, // bright flash returns to its prior scene
		{difference: .1, twoStepDifference: .7},
		{difference: .1, twoStepDifference: .2},
		{difference: .1, twoStepDifference: .2},
		{difference: .1, twoStepDifference: .2},
	}
	resolveFrameScriptTemporalSignals(samples, .32)
	if samples[1].sceneCut != 0 || samples[2].sceneCut != 0 {
		t.Fatalf("flash must not become two scene cuts: %#v", samples[:3])
	}
	transitionFound := false
	for _, sample := range samples[3:] {
		transitionFound = transitionFound || sample.transition > 0
	}
	if !transitionFound {
		t.Fatalf("sustained gradual change must create a transition: %#v", samples[3:])
	}
}

func TestResolveFrameScriptTemporalSignalsUsesRequestedThreshold(t *testing.T) {
	samples := []frameScriptSample{
		{difference: 0},
		{difference: .1},
		{difference: .1},
		{difference: .1},
	}
	resolveFrameScriptTemporalSignals(samples, .9)
	for _, sample := range samples {
		if sample.transition != 0 {
			t.Fatalf("strict threshold must not use the default transition threshold: %#v", samples)
		}
	}
}

func TestFrameScriptCandidateReasonsUseTemporalSignals(t *testing.T) {
	if got := frameScriptCandidateReasons(frameScriptSample{sceneCut: .8}, .8, .32); got[0] != "scene-cut" {
		t.Fatalf("scene reason = %q", got[0])
	}
	if got := frameScriptCandidateReasons(frameScriptSample{transition: .8}, .8, .32); got[0] != "scene-change" {
		t.Fatalf("transition reason = %q", got[0])
	}
	if got := frameScriptCandidateReasons(frameScriptSample{motion: .7}, .7, .32); got[0] != "motion-change" {
		t.Fatalf("motion reason = %q", got[0])
	}
}

func TestReduceFrameScriptCandidatesKeepsLongStaticVideoCovered(t *testing.T) {
	samples := make([]frameScriptSample, frameScriptMaxSamples)
	indexes := make([]int, frameScriptMaxSamples)
	for index := range samples {
		samples[index] = frameScriptSample{timeMs: int64(index) * 5625, quality: .5}
		indexes[index] = index
	}
	kept := reduceFrameScriptCandidates(indexes, samples, 48)
	if len(kept) != 48 || kept[0] != 0 || kept[len(kept)-1] != len(samples)-1 {
		t.Fatalf("reduced boundaries = %#v", kept)
	}
	for index := 1; index < len(kept); index++ {
		if gap := samples[kept[index]].timeMs - samples[kept[index-1]].timeMs; gap > 25_000 {
			t.Fatalf("static coverage gap = %dms, want <= 25000ms", gap)
		}
	}
}

func TestDecodeFrameScriptSamplesWithFFmpeg(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg 未安装")
	}
	path := filepath.Join(t.TempDir(), "sample.mp4")
	if output, err := exec.Command("ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "1", "-pix_fmt", "yuv420p", path).CombinedOutput(); err != nil {
		t.Fatalf("build sample video: %v: %s", err, output)
	}
	frames, err := decodeFrameScriptSamples(context.Background(), path, 320, 180, 400, 1_000, .32)
	if err != nil {
		t.Fatalf("decode frames: %v", err)
	}
	if len(frames) < 2 || len(frames) > frameScriptMaxSamples {
		t.Fatalf("sample count = %d", len(frames))
	}
	if len(frames[0].pixels) != 320*180*3 {
		t.Fatalf("frame pixels = %d, want %d", len(frames[0].pixels), 320*180*3)
	}
}

func TestProbeFrameScriptVideoWithFFmpegWithoutFFprobe(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg 未安装")
	}
	path := filepath.Join(t.TempDir(), "portrait.mp4")
	if output, err := exec.Command("ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25", "-t", "1", "-pix_fmt", "yuv420p", path).CombinedOutput(); err != nil {
		t.Fatalf("build sample video: %v: %s", err, output)
	}
	metadata, err := probeFrameScriptVideoWithFFmpeg(context.Background(), path)
	if err != nil {
		t.Fatalf("probe with ffmpeg: %v", err)
	}
	if metadata.Width != 360 || metadata.Height != 640 || metadata.DurationMs != 1_000 {
		t.Fatalf("metadata = %+v", metadata)
	}
}

func TestDecodeFrameScriptSamplesWithFFmpegKeepsPortraitGeometry(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg 未安装")
	}
	path := filepath.Join(t.TempDir(), "portrait.mp4")
	if output, err := exec.Command("ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25", "-t", "2", "-pix_fmt", "yuv420p", path).CombinedOutput(); err != nil {
		t.Fatalf("build portrait sample: %v: %s", err, output)
	}
	frames, err := decodeFrameScriptSamples(context.Background(), path, 360, 640, 400, 2_000, .32)
	if err != nil {
		t.Fatalf("decode portrait frames: %v", err)
	}
	if len(frames) < 2 {
		t.Fatalf("portrait sample count = %d", len(frames))
	}
	// The bounded long edge must retain the source's 9:16 portrait aspect ratio.
	if got, want := len(frames[0].pixels), 338*600*3; got != want {
		t.Fatalf("portrait frame pixels = %d, want %d", got, want)
	}
}

func TestDecodeFrameScriptSamplesWithFFmpegHonorsCancellation(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg 未安装")
	}
	path := filepath.Join(t.TempDir(), "cancel.mp4")
	if output, err := exec.Command("ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25", "-t", "3", "-pix_fmt", "yuv420p", path).CombinedOutput(); err != nil {
		t.Fatalf("build cancellation sample: %v: %s", err, output)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := decodeFrameScriptSamples(ctx, path, 360, 640, 100, 3_000, .32)
	if err == nil || ctx.Err() == nil {
		t.Fatalf("cancelled decode error = %v, context = %v", err, ctx.Err())
	}
}

// Set FRAMESCRIPT_REAL_VIDEO_PATH to run this smoke test against a local video
// without making a user asset a repository fixture.
func TestDecodeFrameScriptSamplesWithFFmpegRealPortraitVideo(t *testing.T) {
	path := os.Getenv("FRAMESCRIPT_REAL_VIDEO_PATH")
	if path == "" {
		t.Skip("FRAMESCRIPT_REAL_VIDEO_PATH 未设置")
	}
	frames, err := decodeFrameScriptSamples(context.Background(), path, 1080, 1920, 400, 47_100, .32)
	if err != nil {
		t.Fatalf("decode real portrait video: %v", err)
	}
	if len(frames) < 2 || len(frames) > frameScriptMaxSamples {
		t.Fatalf("real portrait frame count = %d", len(frames))
	}
	if got, want := len(frames[0].pixels), 338*600*3; got != want {
		t.Fatalf("real portrait frame pixels = %d, want %d", got, want)
	}
}

func TestSelectFrameScriptCandidatesKeepsBoundariesAndPreviews(t *testing.T) {
	black := make([]byte, 3*3*3)
	gray := make([]byte, 3*3*3)
	for index := range gray {
		gray[index] = 128
	}
	white := make([]byte, 3*3*3)
	for index := range white {
		white[index] = 255
	}
	samples := []frameScriptSample{
		{timeMs: 0, pixels: black, quality: frameScriptQuality(black, 3, 3)},
		{timeMs: 400, pixels: gray, difference: frameScriptPixelDifference(black, gray), quality: frameScriptQuality(gray, 3, 3)},
		{timeMs: 800, pixels: white, difference: frameScriptPixelDifference(gray, white), quality: frameScriptQuality(white, 3, 3)},
	}
	resolveFrameScriptTemporalSignals(samples, .32)
	frames := selectFrameScriptCandidates(samples, 3, 3, .32)
	if len(frames) < 2 {
		t.Fatalf("candidate count = %d, want boundaries", len(frames))
	}
	if frames[0].TimeMs != 0 || !frames[0].HardTrigger || frames[0].Reasons[0] != "opening" {
		t.Fatalf("opening candidate = %#v", frames[0])
	}
	last := frames[len(frames)-1]
	if last.TimeMs != 800 || !last.HardTrigger || last.Reasons[0] != "closing" {
		t.Fatalf("closing candidate = %#v", last)
	}
	for _, frame := range frames {
		if !strings.HasPrefix(frame.PreviewDataURL, "data:image/jpeg;base64,") {
			t.Fatalf("preview missing for %d: %q", frame.TimeMs, frame.PreviewDataURL)
		}
		if frame.Score < 0 || frame.Score > 1 || frame.Quality < 0 || frame.Quality > 1 {
			t.Fatalf("invalid score/quality: %#v", frame)
		}
	}
	if frames[1].Reasons[0] != "scene-cut" || frames[1].ScoreBreakdown.SceneCut == 0 {
		t.Fatalf("high adjacent difference should expose scene cut: %#v", frames[1])
	}
}

func TestExtractFrameScriptKeyframesRejectsForeignResourceBeforeDecoding(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedResource(t, db, "frame-source-a", "owner-a", "video/mp4")
	_, err := svc.ExtractFrameScriptKeyframes(t.Context(), "owner-b", FrameScriptKeyframesRequest{ResourceID: "frame-source-a"})
	if err == nil || !strings.Contains(err.Error(), "视频素材") {
		t.Fatalf("foreign resource error = %v", err)
	}
}

func TestExtractFrameScriptTranscriptionAudioRejectsForeignResourceBeforeDecoding(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	seedResource(t, db, "frame-audio-source-a", "owner-a", "video/mp4")
	_, err := svc.ExtractFrameScriptTranscriptionAudio(t.Context(), "owner-b", "frame-audio-source-a")
	if err == nil || !strings.Contains(err.Error(), "视频素材") {
		t.Fatalf("foreign resource error = %v", err)
	}
}
