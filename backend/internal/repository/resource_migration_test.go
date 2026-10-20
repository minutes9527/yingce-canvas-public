package repository

import (
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestSwitchLocalResourceToOSSIsConditional(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(t.TempDir()+"/migration.db"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Resource{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	resource := &model.Resource{ID: "resource-1", UserID: "user-1", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "users/user-1/image/picture.png", Size: 123}
	if err := repo.CreateResource(resource); err != nil {
		t.Fatal(err)
	}
	switched, err := repo.SwitchLocalResourceToOSS(resource, "s3", "https://r2.example", "media", "location-1", "remote-etag", "")
	if err != nil || !switched {
		t.Fatalf("first switch = %t, %v", switched, err)
	}
	stored, err := repo.Resource(resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Provider != "s3" || stored.ETag != "remote-etag" || stored.StorageSettingID != "location-1" {
		t.Fatalf("stored resource = %#v", stored)
	}
	switched, err = repo.SwitchLocalResourceToOSS(resource, "s3", "https://r2.example", "media", "location-1", "remote-etag", "")
	if err != nil || switched {
		t.Fatalf("repeat switch = %t, %v", switched, err)
	}
}
