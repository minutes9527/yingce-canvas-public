package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// FrameScriptKeyframesRequest only accepts an owned resource ID.  In
// particular it deliberately does not accept a path or URL from the browser.
type FrameScriptKeyframesRequest struct {
	ResourceID         string  `json:"resourceId"`
	SamplingIntervalMs int64   `json:"samplingIntervalMs,omitempty"`
	ChangeThreshold    float64 `json:"changeThreshold,omitempty"`
}

type FrameScriptKeyframesResult struct {
	SourceFingerprint string                `json:"sourceFingerprint"`
	DurationMs        int64                 `json:"durationMs"`
	Keyframes         []FrameScriptKeyframe `json:"keyframes"`
	Detectors         []string              `json:"detectors"`
}

type FrameScriptTranscriptionAudioResult struct {
	Audio             []byte
	SourceFingerprint string
}

type FrameScriptKeyframe struct {
	TimeMs          int64                          `json:"timeMs"`
	Score           float64                        `json:"score"`
	ScoreBreakdown  FrameScriptFrameScoreBreakdown `json:"scoreBreakdown"`
	Confidence      float64                        `json:"confidence"`
	Quality         float64                        `json:"quality"`
	QualityMethod   string                         `json:"qualityMethod"`
	MotionDirection string                         `json:"motionDirection,omitempty"`
	Reasons         []string                       `json:"reasons"`
	HardTrigger     bool                           `json:"hardTrigger"`
	Width           int                            `json:"width"`
	Height          int                            `json:"height"`
	PreviewDataURL  string                         `json:"previewDataUrl,omitempty"`
}

type FrameScriptFrameScoreBreakdown struct {
	AdjacentDifference float64 `json:"adjacentDifference"`
	RetainedDifference float64 `json:"retainedDifference"`
	VisualChange       float64 `json:"visualChange"`
	Corroboration      float64 `json:"corroboration"`
	Composite          float64 `json:"composite"`
	SceneCut           float64 `json:"sceneCut,omitempty"`
	Transition         float64 `json:"transition,omitempty"`
	ExposureChange     float64 `json:"exposureChange,omitempty"`
	Motion             float64 `json:"motion,omitempty"`
}

const (
	frameScriptDefaultIntervalMs = int64(400)
	frameScriptMaxSamples        = 160
	// Visual analysis still reads the confirmed source in the browser. Keep this
	// boundary aligned with that path until its streaming reader is introduced.
	frameScriptMaxBytes      = int64(256 << 20)
	frameScriptMaxDurationMs = int64(15 * 60 * 1000)
	// Candidate previews must be sharp enough for manual review. This stays
	// bounded so server-side scanning remains a lightweight alternative to
	// shipping full-resolution frames into the Canvas process.
	frameScriptSampleMaxEdge = 600
	frameScriptAudioBitrate  = "48k"
	frameScriptAudioMaxBytes = int64(16 << 20)
)

// One streamed decoder at a time keeps the application responsive while
// callers wait in a cancellable queue.
var frameScriptDecoderSlot = make(chan struct{}, 1)
var frameScriptDecoderOnce sync.Once

func acquireFrameScriptDecoder(ctx context.Context) error {
	frameScriptDecoderOnce.Do(func() { frameScriptDecoderSlot <- struct{}{} })
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-frameScriptDecoderSlot:
		return nil
	}
}

func releaseFrameScriptDecoder() { frameScriptDecoderSlot <- struct{}{} }

// ExtractFrameScriptKeyframes materializes an authorized resource, decodes it
// sequentially with ffmpeg and returns only selected bounded previews. No video
// bytes or filesystem paths cross the HTTP boundary.
func (s *Service) ExtractFrameScriptKeyframes(ctx context.Context, userID string, req FrameScriptKeyframesRequest) (*FrameScriptKeyframesResult, error) {
	resourceID := strings.TrimSpace(req.ResourceID)
	if resourceID == "" {
		return nil, BadAuthRequest("必须指定已保存的视频素材")
	}
	resource, err := s.Resource(userID, resourceID)
	if err != nil || resource == nil {
		return nil, BadAuthRequest("无法读取视频素材，可能已被删除")
	}
	if resource.Kind != "video" && !strings.HasPrefix(resource.MimeType, "video/") {
		return nil, BadAuthRequest("FrameScript 仅支持视频素材")
	}
	if resource.Size <= 0 || resource.Size > frameScriptMaxBytes {
		return nil, BadAuthRequest("FrameScript 视频大小必须在 1B 到 256MB 之间")
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return nil, frameScriptUnavailable("视频抽帧依赖未安装（需要 ffmpeg）", err)
	}
	if err := acquireFrameScriptDecoder(ctx); err != nil {
		return nil, frameScriptUnavailable("视频抽帧已取消", err)
	}
	defer releaseFrameScriptDecoder()

	workDir, err := os.MkdirTemp("", "yingce-framescript-*")
	if err != nil {
		return nil, fmt.Errorf("创建视频抽帧工作目录失败: %w", err)
	}
	defer os.RemoveAll(workDir)
	inputPath := filepath.Join(workDir, "input"+extForMime(resource.MimeType))
	fingerprint, err := s.materializeFrameScriptVideo(ctx, userID, resourceID, inputPath)
	if err != nil {
		return nil, err
	}
	metadata, err := probeFrameScriptVideo(ctx, inputPath)
	if err != nil {
		return nil, err
	}
	if metadata.DurationMs <= 0 || metadata.Width <= 0 || metadata.Height <= 0 {
		return nil, BadAuthRequest("无法读取视频时长或尺寸")
	}
	if metadata.DurationMs > frameScriptMaxDurationMs {
		return nil, BadAuthRequest("视频时长不能超过 15 分钟")
	}
	interval := normalizedFrameScriptInterval(req.SamplingIntervalMs, metadata.DurationMs)
	threshold := req.ChangeThreshold
	if threshold == 0 {
		threshold = 0.32
	}
	if threshold < 0.01 || threshold > 1 || math.IsNaN(threshold) || math.IsInf(threshold, 0) {
		return nil, BadAuthRequest("候选帧变化阈值无效")
	}
	frames, err := decodeFrameScriptSamples(ctx, inputPath, metadata.Width, metadata.Height, interval, metadata.DurationMs, threshold)
	if err != nil {
		return nil, err
	}
	keyframes := selectFrameScriptCandidates(frames, metadata.Width, metadata.Height, threshold)
	if len(keyframes) == 0 {
		return nil, BadAuthRequest("未能从视频中提取候选画面")
	}
	return &FrameScriptKeyframesResult{
		SourceFingerprint: fingerprint,
		DurationMs:        metadata.DurationMs,
		Keyframes:         keyframes,
		Detectors:         []string{"ffmpeg-sequential-decode-v1", "adjacent-pixel-difference", "scene-cut-temporal-v1", "transition-temporal-v1", "exposure-change-v1", "motion-shift-v1", "local-laplacian-exposure-v1"},
	}, nil
}

// ExtractFrameScriptTranscriptionAudio turns an owned video into a bounded MP3
// for a speech model.  In particular, it never labels an MP4 byte stream as
// audio: DashScope validates the encoded bytes against input_audio.format.
func (s *Service) ExtractFrameScriptTranscriptionAudio(ctx context.Context, userID, resourceID string) (*FrameScriptTranscriptionAudioResult, error) {
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil, BadAuthRequest("必须指定已保存的视频素材")
	}
	resource, err := s.Resource(userID, resourceID)
	if err != nil || resource == nil {
		return nil, BadAuthRequest("无法读取视频素材，可能已被删除")
	}
	if resource.Kind != "video" && !strings.HasPrefix(resource.MimeType, "video/") {
		return nil, BadAuthRequest("FrameScript 仅支持视频素材")
	}
	if resource.Size <= 0 || resource.Size > frameScriptMaxBytes {
		return nil, BadAuthRequest("FrameScript 视频大小必须在 1B 到 256MB 之间")
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return nil, frameScriptUnavailable("语音转写依赖未安装（需要 ffmpeg）", err)
	}
	if err := acquireFrameScriptDecoder(ctx); err != nil {
		return nil, frameScriptUnavailable("语音转写已取消", err)
	}
	defer releaseFrameScriptDecoder()

	workDir, err := os.MkdirTemp("", "yingce-framescript-audio-*")
	if err != nil {
		return nil, fmt.Errorf("创建语音转写工作目录失败: %w", err)
	}
	defer os.RemoveAll(workDir)
	inputPath := filepath.Join(workDir, "input"+extForMime(resource.MimeType))
	fingerprint, err := s.materializeFrameScriptVideo(ctx, userID, resourceID, inputPath)
	if err != nil {
		return nil, err
	}
	outputPath := filepath.Join(workDir, "transcription.mp3")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-i", inputPath, "-map", "0:a:0?", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", frameScriptAudioBitrate, "-f", "mp3", "-y", outputPath)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if len(detail) > 300 {
			detail = detail[len(detail)-300:]
		}
		message := "提取视频音轨失败"
		if detail != "" {
			message += "：" + detail
		}
		return nil, frameScriptUnavailable(message, err)
	}
	info, err := os.Stat(outputPath)
	if err != nil || info.Size() <= 0 {
		return nil, BadAuthRequest("视频中没有可用音频")
	}
	if info.Size() > frameScriptAudioMaxBytes {
		return nil, BadAuthRequest("视频音频过大，无法用于语音转写")
	}
	audio, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, fmt.Errorf("读取转写音频失败: %w", err)
	}
	return &FrameScriptTranscriptionAudioResult{Audio: audio, SourceFingerprint: fingerprint}, nil
}

func frameScriptUnavailable(message string, cause error) *AppError {
	err := NewAppError(http.StatusServiceUnavailable, message)
	err.Retryable = true
	err.Cause = cause
	return err
}

func (s *Service) materializeFrameScriptVideo(ctx context.Context, userID, resourceID, output string) (string, error) {
	_, reader, err := s.OpenResource(userID, resourceID)
	if err != nil || reader == nil {
		return "", BadAuthRequest("无法读取视频素材，可能已被删除")
	}
	defer reader.Close()
	file, err := os.Create(output)
	if err != nil {
		return "", fmt.Errorf("写入待抽帧视频失败: %w", err)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(file, hash), &contextReader{ctx: ctx, reader: reader}); err != nil {
		return "", fmt.Errorf("读取待抽帧视频失败: %w", err)
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}

type frameScriptVideoMetadata struct {
	DurationMs    int64
	Width, Height int
}

func probeFrameScriptVideo(ctx context.Context, path string) (frameScriptVideoMetadata, error) {
	cmd := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path)
	output, err := cmd.Output()
	var payload struct {
		Streams []struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err == nil && json.Unmarshal(output, &payload) == nil && len(payload.Streams) > 0 {
		var seconds float64
		if _, err := fmt.Sscan(payload.Format.Duration, &seconds); err == nil && seconds > 0 {
			return frameScriptVideoMetadata{DurationMs: int64(math.Round(seconds * 1000)), Width: payload.Streams[0].Width, Height: payload.Streams[0].Height}, nil
		}
	}
	return probeFrameScriptVideoWithFFmpeg(ctx, path)
}

var (
	frameScriptDurationPattern   = regexp.MustCompile(`Duration:\s*(\d{2}):(\d{2}):(\d+(?:\.\d+)?)`)
	frameScriptDimensionsPattern = regexp.MustCompile(`(?m)Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})`)
)

// probeFrameScriptVideoWithFFmpeg keeps keyframe extraction available on hosts
// where ffprobe is absent or cannot start but ffmpeg is usable. The decoder is
// already required by the next pipeline stage, so this does not add a second
// native dependency to local development.
func probeFrameScriptVideoWithFFmpeg(ctx context.Context, path string) (frameScriptVideoMetadata, error) {
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-i", path)
	output, _ := cmd.CombinedOutput()
	text := string(output)
	duration := frameScriptDurationPattern.FindStringSubmatch(text)
	dimensions := frameScriptDimensionsPattern.FindStringSubmatch(text)
	if len(duration) != 4 || len(dimensions) != 3 {
		return frameScriptVideoMetadata{}, BadAuthRequest("无法读取视频时长或尺寸")
	}
	var hours, minutes int64
	var seconds float64
	var width, height int
	if _, err := fmt.Sscan(duration[1], &hours); err != nil {
		return frameScriptVideoMetadata{}, BadAuthRequest("无法读取视频时长")
	}
	if _, err := fmt.Sscan(duration[2], &minutes); err != nil {
		return frameScriptVideoMetadata{}, BadAuthRequest("无法读取视频时长")
	}
	if _, err := fmt.Sscan(duration[3], &seconds); err != nil || seconds <= 0 {
		return frameScriptVideoMetadata{}, BadAuthRequest("无法读取视频时长")
	}
	if _, err := fmt.Sscan(dimensions[1], &width); err != nil {
		return frameScriptVideoMetadata{}, BadAuthRequest("无法读取视频尺寸")
	}
	if _, err := fmt.Sscan(dimensions[2], &height); err != nil {
		return frameScriptVideoMetadata{}, BadAuthRequest("无法读取视频尺寸")
	}
	durationMs := int64(math.Round((float64(hours*3600+minutes*60) + seconds) * 1000))
	if durationMs <= 0 || width <= 0 || height <= 0 {
		return frameScriptVideoMetadata{}, BadAuthRequest("无法读取视频时长或尺寸")
	}
	return frameScriptVideoMetadata{DurationMs: durationMs, Width: width, Height: height}, nil
}

func normalizedFrameScriptInterval(requested, durationMs int64) int64 {
	interval := requested
	if interval == 0 {
		interval = frameScriptDefaultIntervalMs
	}
	if interval < 100 {
		interval = 100
	}
	if interval > 2000 {
		interval = 2000
	}
	return max(interval, int64(math.Ceil(float64(durationMs)/frameScriptMaxSamples)))
}

type frameScriptSample struct {
	timeMs                                       int64
	pixels                                       []byte
	difference, quality, twoStepDifference       float64
	exposureChange, motion, sceneCut, transition float64
	motionDirection                              string
}

func decodeFrameScriptSamples(ctx context.Context, path string, sourceWidth, sourceHeight int, interval, durationMs int64, threshold float64) ([]frameScriptSample, error) {
	width, height := frameScriptSampleDimensions(sourceWidth, sourceHeight)
	frameBytes := width * height * 3
	filter := fmt.Sprintf("fps=1000/%d,scale=%d:%d:flags=fast_bilinear", interval, width, height)
	// Limit ffmpeg itself instead of breaking the pipe reader after 160 frames.
	// Breaking the reader while ffmpeg is still writing can deadlock Wait on a
	// full stdout pipe for videos whose fps rounding produces an extra frame.
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1", "-i", path, "-vf", filter, "-an", "-frames:v", fmt.Sprint(frameScriptMaxSamples), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("创建视频抽帧管道失败: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, frameScriptUnavailable("启动视频抽帧失败", err)
	}
	var samples []frameScriptSample
	var previous, twoStepsBack []byte
	previousLuma := 0.0
	for index := 0; ; index++ {
		pixels := make([]byte, frameBytes)
		_, readErr := io.ReadFull(stdout, pixels)
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			break
		}
		if readErr != nil {
			_ = cmd.Wait()
			return nil, fmt.Errorf("读取视频候选帧失败: %w", readErr)
		}
		timeMs := min(int64(index)*interval, max(int64(0), durationMs-1))
		diff, twoStep, exposure, motion := 0.0, 0.0, 0.0, 0.0
		direction := "static"
		luma := frameScriptMeanLuma(pixels)
		if previous != nil {
			diff = frameScriptPixelDifference(previous, pixels)
			exposure = math.Abs(luma - previousLuma)
			motion, direction = frameScriptMotion(previous, pixels, width, height, diff)
		}
		if twoStepsBack != nil {
			twoStep = frameScriptPixelDifference(twoStepsBack, pixels)
		}
		samples = append(samples, frameScriptSample{timeMs: timeMs, pixels: pixels, difference: diff, twoStepDifference: twoStep, exposureChange: exposure, motion: motion, motionDirection: direction, quality: frameScriptQuality(pixels, width, height)})
		twoStepsBack = previous
		previous = pixels
		previousLuma = luma
	}
	if err := cmd.Wait(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if len(detail) > 300 {
			detail = detail[len(detail)-300:]
		}
		return nil, frameScriptUnavailable("视频抽帧失败"+func() string {
			if detail != "" {
				return "：" + detail
			}
			return ""
		}(), err)
	}
	resolveFrameScriptTemporalSignals(samples, threshold)
	return samples, nil
}

func frameScriptSampleDimensions(width, height int) (int, int) {
	scale := math.Min(1, float64(frameScriptSampleMaxEdge)/float64(max(width, height)))
	return max(3, int(math.Round(float64(width)*scale))), max(3, int(math.Round(float64(height)*scale)))
}

func frameScriptPixelDifference(left, right []byte) float64 {
	var total int64
	for i := 0; i < len(left); i++ {
		delta := int(left[i]) - int(right[i])
		if delta < 0 {
			delta = -delta
		}
		total += int64(delta)
	}
	return float64(total) / float64(max(1, len(left))*255)
}

func frameScriptMeanLuma(pixels []byte) float64 {
	var total float64
	for index := 0; index+2 < len(pixels); index += 3 {
		total += (0.2126*float64(pixels[index]) + 0.7152*float64(pixels[index+1]) + 0.0722*float64(pixels[index+2])) / 255
	}
	return total / float64(max(1, len(pixels)/3))
}

// frameScriptMotion is a small deterministic shift search. It is a motion cue
// for selecting review frames, not a claim about object or camera tracking.
func frameScriptMotion(previous, current []byte, width, height int, baseline float64) (float64, string) {
	if baseline < .03 || width < 8 || height < 8 {
		return 0, "static"
	}
	type shift struct {
		dx, dy    int
		direction string
	}
	shifts := []shift{
		{dx: -2, dy: 0, direction: "right"}, {dx: 2, dy: 0, direction: "left"},
		{dx: 0, dy: -2, direction: "down"}, {dx: 0, dy: 2, direction: "up"},
	}
	bestError := math.Inf(1)
	bestDirection := "static"
	for _, candidate := range shifts {
		startX, endX := 0, width
		if candidate.dx < 0 {
			startX = -candidate.dx
		} else {
			endX = width - candidate.dx
		}
		startY, endY := 0, height
		if candidate.dy < 0 {
			startY = -candidate.dy
		} else {
			endY = height - candidate.dy
		}
		var total, count int64
		for y := startY; y < endY; y += 3 {
			for x := startX; x < endX; x += 3 {
				currentIndex := (y*width + x) * 3
				previousIndex := ((y+candidate.dy)*width + x + candidate.dx) * 3
				for channel := 0; channel < 3; channel++ {
					delta := int(current[currentIndex+channel]) - int(previous[previousIndex+channel])
					if delta < 0 {
						delta = -delta
					}
					total += int64(delta)
				}
				count += 3 * 255
			}
		}
		error := float64(total) / float64(max(int(count), 1))
		if error < bestError {
			bestError, bestDirection = error, candidate.direction
		}
	}
	score := clampFrameScript((baseline - bestError) / maxFloat(.08, baseline))
	if score < .18 {
		return 0, "static"
	}
	return score, bestDirection
}

// resolveFrameScriptTemporalSignals suppresses single-frame flashes and
// recognizes sustained small changes as a gradual transition.
func resolveFrameScriptTemporalSignals(samples []frameScriptSample, threshold float64) {
	const sceneCutThreshold = .5
	for index := 1; index < len(samples); index++ {
		if samples[index].difference < sceneCutThreshold || frameScriptFlashBoundary(samples, index, sceneCutThreshold) {
			continue
		}
		samples[index].sceneCut = clampFrameScript(samples[index].difference / sceneCutThreshold)
	}
	const gradualStepThreshold = .035
	gradualTransitionThreshold := maxFloat(.25, threshold*.9)
	runStart, accumulated := -1, 0.0
	for index := 1; index < len(samples); index++ {
		sample := &samples[index]
		gradualStep := sample.difference >= gradualStepThreshold && sample.difference < sceneCutThreshold && !frameScriptFlashBoundary(samples, index, sceneCutThreshold)
		if !gradualStep {
			runStart, accumulated = -1, 0
			continue
		}
		if runStart < 0 {
			runStart = index
		}
		accumulated += sample.difference
		if index-runStart+1 >= 3 && accumulated >= gradualTransitionThreshold {
			sample.transition = clampFrameScript(accumulated / gradualTransitionThreshold)
			runStart, accumulated = -1, 0
		}
	}
}

func frameScriptFlashBoundary(samples []frameScriptSample, index int, sceneCutThreshold float64) bool {
	const recoveryThreshold = .16
	current := samples[index]
	if index+1 < len(samples) {
		next := samples[index+1]
		if next.difference >= sceneCutThreshold && next.twoStepDifference <= recoveryThreshold {
			return true
		}
	}
	if index > 0 {
		previous := samples[index-1]
		if previous.difference >= sceneCutThreshold && current.twoStepDifference <= recoveryThreshold {
			return true
		}
	}
	return false
}

func frameScriptQuality(pixels []byte, width, height int) float64 {
	gray := make([]float64, width*height)
	clipped := 0
	for i := range gray {
		value := (0.299*float64(pixels[i*3]) + 0.587*float64(pixels[i*3+1]) + 0.114*float64(pixels[i*3+2])) / 255
		gray[i] = value
		if value <= .02 || value >= .98 {
			clipped++
		}
	}
	var sum, squares float64
	count := (width - 2) * (height - 2)
	for y := 1; y < height-1; y++ {
		for x := 1; x < width-1; x++ {
			i := y*width + x
			edge := gray[i-1] + gray[i+1] + gray[i-width] + gray[i+width] - 4*gray[i]
			sum += edge
			squares += edge * edge
		}
	}
	variance := maxFloat(0, squares/float64(count)-math.Pow(sum/float64(count), 2))
	return clampFrameScript((variance / (variance + .02)) * (1 - float64(clipped)/float64(len(gray))))
}

func selectFrameScriptCandidates(samples []frameScriptSample, sourceWidth, sourceHeight int, threshold float64) []FrameScriptKeyframe {
	if len(samples) == 0 {
		return nil
	}
	selected := map[int][]string{0: {"opening"}}
	if len(samples) > 1 {
		selected[len(samples)-1] = []string{"closing"}
	}
	minimumPeak := maxFloat(.08, threshold*.45)
	for i := 1; i < len(samples)-1; i++ {
		current := frameScriptCandidateSignal(samples[i])
		if current >= threshold {
			selected[i] = frameScriptCandidateReasons(samples[i], current, threshold)
			continue
		}
		if current >= minimumPeak && current >= frameScriptCandidateSignal(samples[i-1]) && current >= frameScriptCandidateSignal(samples[i+1]) {
			selected[i] = []string{"visual-change"}
		}
	}
	// Ensure long static passages still get a review point without flooding the UI.
	const maxGapMs = int64(8000)
	last := 0
	for i := 1; i < len(samples); i++ {
		if samples[i].timeMs-samples[last].timeMs < maxGapMs {
			continue
		}
		best := last + 1
		for j := last + 1; j <= i; j++ {
			if frameScriptCandidatePriority(samples[j]) >= frameScriptCandidatePriority(samples[best]) {
				best = j
			}
		}
		if _, exists := selected[best]; !exists {
			selected[best] = []string{"max-gap"}
		}
		last = best
	}
	indexes := make([]int, 0, len(selected))
	for index := range selected {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	if len(indexes) > 48 {
		indexes = reduceFrameScriptCandidates(indexes, samples, 48)
	}
	result := make([]FrameScriptKeyframe, 0, len(indexes))
	var retained []byte
	for _, index := range indexes {
		sample := samples[index]
		retainedDiff := 0.0
		if retained != nil {
			retainedDiff = frameScriptPixelDifference(retained, sample.pixels)
		}
		retained = sample.pixels
		adjacent := clampFrameScript(sample.difference)
		sceneCut, transition, exposure, motion := clampFrameScript(sample.sceneCut), clampFrameScript(sample.transition), clampFrameScript(sample.exposureChange), clampFrameScript(sample.motion)
		structural := []float64{sceneCut, transition, exposure}
		visual := maxFloat(maxFloat(adjacent, retainedDiff), maxFloat(sceneCut, maxFloat(transition, exposure)))
		signalValues := []float64{adjacent, retainedDiff}
		for _, value := range structural {
			if value > 0 {
				signalValues = append(signalValues, value)
			}
		}
		corroboration := (adjacent + retainedDiff) / 2
		if len(signalValues) > 2 {
			corroboration = 0
			for _, value := range signalValues {
				corroboration += value
			}
			corroboration /= float64(len(signalValues))
		}
		hasExtendedSignals := sceneCut > 0 || transition > 0 || exposure > 0 || motion > 0
		composite := clampFrameScript(visual*.75 + corroboration*.25)
		if hasExtendedSignals {
			composite = clampFrameScript(visual*.5 + corroboration*.2 + maxFloat(sceneCut, maxFloat(transition, exposure))*.1 + motion*.05)
		}
		reasons := selected[index]
		hard := reasons[0] == "opening" || reasons[0] == "closing"
		previewWidth, previewHeight := frameScriptSampleDimensions(sourceWidth, sourceHeight)
		preview, _ := frameScriptPreviewDataURL(sample.pixels, previewWidth, previewHeight)
		result = append(result, FrameScriptKeyframe{TimeMs: sample.timeMs, Score: composite, ScoreBreakdown: FrameScriptFrameScoreBreakdown{AdjacentDifference: adjacent, RetainedDifference: retainedDiff, VisualChange: visual, Corroboration: corroboration, Composite: composite, SceneCut: sceneCut, Transition: transition, ExposureChange: exposure, Motion: motion}, Confidence: clampFrameScript(.5 + corroboration*.5), Quality: sample.quality, QualityMethod: "local-laplacian-exposure-v1", MotionDirection: sample.motionDirection, Reasons: reasons, HardTrigger: hard, Width: sourceWidth, Height: sourceHeight, PreviewDataURL: preview})
	}
	return result
}

func reduceFrameScriptCandidates(indexes []int, samples []frameScriptSample, limit int) []int {
	if len(indexes) <= limit {
		return indexes
	}
	// Preserve opening/closing and divide the remaining timeline into equal
	// windows. Selecting only the globally strongest changes can erase the end
	// of a long static video entirely.
	keep := []int{indexes[0]}
	middle := indexes[1 : len(indexes)-1]
	slots := limit - 2
	for slot := 0; slot < slots; slot++ {
		start := slot * len(middle) / slots
		end := (slot + 1) * len(middle) / slots
		if end <= start {
			continue
		}
		best := middle[start]
		for _, candidate := range middle[start+1 : end] {
			if frameScriptCandidatePriority(samples[candidate]) >= frameScriptCandidatePriority(samples[best]) {
				best = candidate
			}
		}
		keep = append(keep, best)
	}
	keep = append(keep, indexes[len(indexes)-1])
	sort.Ints(keep)
	return keep
}

// A clean frame is preferred when two visual changes carry comparable signal.
// It only ranks candidates; opening, closing and scene-cut timing stay intact.
func frameScriptCandidatePriority(sample frameScriptSample) float64 {
	return frameScriptCandidateSignal(sample)*.8 + sample.quality*.2
}

func frameScriptCandidateSignal(sample frameScriptSample) float64 {
	return maxFloat(sample.difference, maxFloat(sample.sceneCut, maxFloat(sample.transition, maxFloat(sample.exposureChange, sample.motion))))
}

func frameScriptCandidateReasons(sample frameScriptSample, composite, threshold float64) []string {
	if sample.sceneCut >= .7 {
		return []string{"scene-cut"}
	}
	if sample.transition >= .62 {
		return []string{"scene-change"}
	}
	if sample.motion >= .58 && composite >= threshold {
		return []string{"motion-change"}
	}
	return []string{"visual-change"}
}

func frameScriptPreviewDataURL(pixels []byte, dimensions ...int) (string, error) {
	if len(dimensions) != 2 {
		return "", fmt.Errorf("候选帧尺寸无效")
	}
	width, height := dimensions[0], dimensions[1]
	imageData := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < width*height; i++ {
		imageData.Pix[i*4], imageData.Pix[i*4+1], imageData.Pix[i*4+2], imageData.Pix[i*4+3] = pixels[i*3], pixels[i*3+1], pixels[i*3+2], 255
	}
	var output bytes.Buffer
	if err := jpeg.Encode(&output, imageData, &jpeg.Options{Quality: 88}); err != nil {
		return "", err
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(output.Bytes()), nil
}

func clampFrameScript(value float64) float64 {
	if value < 0 || math.IsNaN(value) {
		return 0
	}
	if value > 1 || math.IsInf(value, 0) {
		return 1
	}
	return math.Round(value*10000) / 10000
}
func maxFloat(left, right float64) float64 {
	if left > right {
		return left
	}
	return right
}
