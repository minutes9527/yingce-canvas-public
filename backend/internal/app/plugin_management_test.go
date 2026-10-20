package app

import (
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
	"yingce/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestApplicationPluginUsesUserStateUnderPlatformAvailability(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.PluginPlatformState{}, &model.UserPluginState{}, &model.AdminAuditEvent{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	center, err := newPluginRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repository.New(db), pluginRuntime: center}
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	admin := &model.User{ID: "admin-1", Role: model.UserRoleAdmin}

	states, err := svc.PluginStatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	initial := states[WorkflowPluginRunningHub]
	if !initial.PlatformAvailable || initial.UserEnabled || initial.EffectiveEnabled || !initial.CanToggle {
		t.Fatalf("initial RunningHub state = %#v", initial)
	}

	enabled, err := svc.SetUserPluginEnabled(user, WorkflowPluginRunningHub, true)
	if err != nil {
		t.Fatal(err)
	}
	if !enabled.UserConfigured || !enabled.UserEnabled || !enabled.EffectiveEnabled {
		t.Fatalf("enabled RunningHub state = %#v", enabled)
	}
	if _, err := svc.SetPluginPlatformAvailability(user, WorkflowPluginRunningHub, false); err == nil {
		t.Fatal("ordinary user changed platform plugin availability")
	}
	disabled, err := svc.SetPluginPlatformAvailability(admin, WorkflowPluginRunningHub, false)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.PlatformAvailable || disabled.EffectiveEnabled || disabled.EnabledUserCount != 1 {
		t.Fatalf("platform-disabled RunningHub state = %#v", disabled)
	}
	if err := svc.RequireWorkflowPluginForUser(user.ID, "runninghub-workflow-image"); err == nil {
		t.Fatal("platform-disabled workflow was accepted for a new user request")
	}
	if _, err := svc.SetPluginPlatformAvailability(admin, WorkflowPluginRunningHub, true); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequireWorkflowPluginForUser(user.ID, "runninghub-workflow-video"); err != nil {
		t.Fatalf("restored user workflow rejected: %v", err)
	}
}

func TestUploadedManifestCannotClaimUserActivationScope(t *testing.T) {
	policy := pluginManagement(PluginPromptOptimizer, PluginOriginUploaded)
	if policy.Origin != PluginOriginUploaded || policy.ActivationScope != PluginScopeSystem || policy.ConfigurationScope != PluginConfigurationSystem {
		t.Fatalf("uploaded plugin policy = %#v", policy)
	}
}

func TestPaymentContributionInfersPaymentManagementKind(t *testing.T) {
	plugin := PluginView{
		Source: PluginOriginOfficial,
		Manifest: PluginManifestView{
			ID: "official-payment-xunhupay",
			Contributes: protocol.ManifestContributions{PaymentProviders: []protocol.ManifestPaymentProvider{{
				ID: "xunhupay-aggregate", Label: "虎皮椒聚合支付", Icon: "assets/icon.svg", CheckoutMode: "qr_code",
			}}},
		},
	}
	policy := pluginManagementFromView(plugin)
	if policy.Kind != PluginKindPayment || policy.Origin != PluginOriginOfficial || policy.ActivationScope != PluginScopeSystem {
		t.Fatalf("inferred payment policy = %#v", policy)
	}
}

func TestArtCritiqueIsUserToggleableApplication(t *testing.T) {
	policy := pluginManagement(PluginAIArtCritique, "bundled")
	if policy.Origin != PluginOriginOfficial || policy.Kind != PluginKindApplication || policy.ActivationScope != PluginScopeUser || policy.ConfigurationScope != PluginConfigurationNone {
		t.Fatalf("AI art critique policy = %#v", policy)
	}
}

// Regression: editor-shell was missing from officialApplicationPolicies, so the
// backend classified it as a system protocol and reported it to the admin page
// as "管理员已停用该插件" even though nothing disabled it.
func TestEditorShellIsUserToggleableApplication(t *testing.T) {
	policy := pluginManagement(PluginEditorShell, "bundled")
	if policy.Origin != PluginOriginOfficial || policy.Kind != PluginKindApplication || policy.ActivationScope != PluginScopeUser || policy.ConfigurationScope != PluginConfigurationNone {
		t.Fatalf("editor shell policy = %#v", policy)
	}
}

func TestEditorShellReportsPlatformAvailableWithoutPlatformState(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.PluginPlatformState{}, &model.UserPluginState{}, &model.AdminAuditEvent{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	center, err := newPluginRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repository.New(db), pluginRuntime: center}
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}

	states, err := svc.PluginStatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	state, ok := states[PluginEditorShell]
	if !ok {
		t.Fatalf("editor shell missing from plugin states: %#v", states)
	}
	if !state.PlatformAvailable || !state.CanToggle {
		t.Fatalf("editor shell should be a user-toggleable application, got %#v", state)
	}
	if state.BlockedReason == "管理员已停用该插件" {
		t.Fatalf("editor shell reported as admin-disabled: %#v", state)
	}
}

func TestFrameScriptVideoUsesSystemConfiguration(t *testing.T) {
	policy := pluginManagement(PluginFrameScriptVideo, PluginOriginOfficial)
	if policy.Origin != PluginOriginOfficial || policy.Kind != PluginKindApplication ||
		policy.ActivationScope != PluginScopeSystem || policy.ConfigurationScope != PluginConfigurationSystem {
		t.Fatalf("FrameScript video plugin policy = %#v", policy)
	}
}

func TestFrameScriptVideoAdminConfigEnablesOrdinaryUser(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.PluginPlatformState{}, &model.UserPluginState{}, &model.AdminAuditEvent{}, &model.SystemSetting{}, &model.ModelChannel{}, &model.ChannelModel{}, &model.ChannelModelPriceTier{}); err != nil {
		t.Fatal(err)
	}
	center, err := newPluginRuntime(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc := &Service{repo: repository.New(db), pluginRuntime: center}
	admin := &model.User{ID: "admin-1", Role: model.UserRoleAdmin}
	user := &model.User{ID: "user-1", Role: model.UserRoleUser}
	config := FrameScriptConfig{ChannelID: "channel-1", VisionModel: "vision-vl", PromptModel: "vision-vl", TranscriptionModel: "whisper-1", ChangeThreshold: .32, SamplingIntervalMs: 400}
	if _, err := svc.SaveFrameScriptConfig(user, config); err == nil {
		t.Fatal("ordinary user saved platform config")
	}
	if _, err := svc.SetPluginPlatformAvailability(admin, PluginFrameScriptVideo, true); err == nil {
		t.Fatal("plugin enabled without admin config")
	}
	if err := db.Create(&model.ModelChannel{ID: config.ChannelID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "test"}).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct{ key, capability string }{{config.VisionModel, "text"}, {"text-model", "text"}, {config.TranscriptionModel, "audio"}} {
		item := model.ChannelModel{ID: newID(), ChannelID: config.ChannelID, ModelKey: row.key, Capability: row.capability, Enabled: true, PriceConfigured: true}
		if err := db.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.ChannelModelPriceTier{ID: newID(), ChannelModelID: item.ID, SelectorKey: "{}", Enabled: true, PriceConfigured: true}).Error; err != nil {
			t.Fatal(err)
		}
	}
	invalidPrompt := config
	invalidPrompt.PromptModel = "text-model"
	if _, err := svc.SaveFrameScriptConfig(admin, invalidPrompt); err == nil {
		t.Fatal("text-only model accepted for image prompt extraction")
	}
	if _, err := svc.SaveFrameScriptConfig(admin, config); err != nil {
		t.Fatalf("admin config save: %v", err)
	}
	if _, err := svc.SetPluginPlatformAvailability(admin, PluginFrameScriptVideo, true); err != nil {
		t.Fatalf("admin enable: %v", err)
	}
	states, err := svc.PluginStatesForUser(user)
	if err != nil {
		t.Fatal(err)
	}
	state := states[PluginFrameScriptVideo]
	if !state.EffectiveEnabled || state.CanConfigure || state.CanToggle {
		t.Fatalf("ordinary user plugin state = %#v", state)
	}
	got, err := svc.FrameScriptRuntimeConfig(user)
	if err != nil || got == nil || got.VisionModel != config.VisionModel {
		t.Fatalf("ordinary user config = %#v, %v", got, err)
	}
	if err := db.Model(&model.ChannelModel{}).Where("channel_id = ? AND model_key = ?", config.ChannelID, config.VisionModel).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.FrameScriptRuntimeConfig(user); err == nil {
		t.Fatal("runtime config accepted a disabled model")
	}
	if _, err := svc.SetUserPluginEnabled(user, PluginFrameScriptVideo, false); err == nil {
		t.Fatal("ordinary user disabled platform plugin")
	}
}
