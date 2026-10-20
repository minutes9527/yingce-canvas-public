package repository

import (
	"time"

	"yingce/backend/internal/model"
)

// ReadyLocalResources returns only records still served from the server volume.
func (r *Repository) ReadyLocalResources() ([]model.Resource, error) {
	var resources []model.Resource
	err := r.db.Where("provider = ? AND status = ?", "local", model.ResourceStatusReady).
		Order("created_at asc").Find(&resources).Error
	return resources, err
}

// SwitchLocalResourceToOSS binds a verified remote copy without overwriting a
// resource that changed while the copy was in progress.
func (r *Repository) SwitchLocalResourceToOSS(resource *model.Resource, provider, endpoint, bucket, locationID, etag, playbackKey string) (bool, error) {
	values := map[string]any{
		"provider": provider, "endpoint": endpoint, "bucket": bucket,
		"storage_setting_id": locationID, "e_tag": etag,
		"playback_object_key": playbackKey, "updated_at": time.Now().UTC(),
	}
	result := r.db.Model(&model.Resource{}).
		Where("id = ? AND user_id = ? AND status = ? AND provider = ? AND object_key = ? AND size = ? AND playback_status = ? AND playback_object_key = ?",
			resource.ID, resource.UserID, model.ResourceStatusReady, "local", resource.ObjectKey, resource.Size, resource.PlaybackStatus, resource.PlaybackObjectKey).
		Updates(values)
	return result.RowsAffected == 1, result.Error
}
