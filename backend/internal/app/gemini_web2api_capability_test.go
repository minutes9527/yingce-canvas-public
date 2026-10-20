package app

import "testing"

func TestGeminiWeb2APIImageDefaults(t *testing.T) {
	profile := DefaultImageCapabilityConfig("gemini-web2api-image", "gemini-image")
	if profile == nil {
		t.Fatal("gemini-web2api image profile is nil")
	}
	normalized, err := NormalizeModelCapabilityConfigForModel("image", "gemini-web2api-image", "gemini-image", &ModelCapabilityConfig{Version: 1, Image: profile})
	if err != nil || normalized == nil || normalized.Image == nil {
		t.Fatalf("NormalizeModelCapabilityConfigForModel() = %#v, %v", normalized, err)
	}
	image := normalized.Image
	if image.Size.Parameter != "none" || image.MaxOutputs != 1 || image.Quality.Supported || image.References.MaskSupported || image.TransparentBackground.Supported || image.OutputFormat.Supported || image.ResponseFormat.Supported {
		t.Fatal("proxy image defaults must not advertise unsupported controls")
	}
}
