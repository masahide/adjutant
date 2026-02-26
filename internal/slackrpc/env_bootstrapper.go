package slackrpc

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	envXOXPToken     = "SLACK_MCP_XOXP_TOKEN"
	envXOXBToken     = "SLACK_MCP_XOXB_TOKEN"
	envXOXCToken     = "SLACK_MCP_XOXC_TOKEN"
	envXOXDToken     = "SLACK_MCP_XOXD_TOKEN"
	envUsersCache    = "SLACK_MCP_USERS_CACHE"
	envChannelsCache = "SLACK_MCP_CHANNELS_CACHE"
)

var managedEnvKeys = []string{
	envXOXPToken,
	envXOXBToken,
	envXOXCToken,
	envXOXDToken,
	envUsersCache,
	envChannelsCache,
}

type EnvBootstrapper struct {
	mu sync.Mutex
}

func NewEnvBootstrapper() *EnvBootstrapper {
	return &EnvBootstrapper{}
}

func (b *EnvBootstrapper) WithWorkspaceEnv(cfg WorkspaceConfig, fn func() error) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	original := snapshotEnv(managedEnvKeys)
	defer restoreEnv(original)

	cacheDir := cfg.CacheDir
	if cacheDir == "" {
		cacheDir = filepath.Join(os.TempDir(), "slack-rpc-gateway", cfg.WorkspaceKey)
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}

	usersCachePath := filepath.Join(cacheDir, "users_cache.json")
	channelsCachePath := filepath.Join(cacheDir, "channels_cache_v2.json")

	if err := os.Setenv(envXOXPToken, ""); err != nil {
		return fmt.Errorf("set %s: %w", envXOXPToken, err)
	}
	if err := os.Setenv(envXOXBToken, ""); err != nil {
		return fmt.Errorf("set %s: %w", envXOXBToken, err)
	}
	if err := os.Setenv(envXOXCToken, cfg.XOXC); err != nil {
		return fmt.Errorf("set %s: %w", envXOXCToken, err)
	}
	if err := os.Setenv(envXOXDToken, cfg.XOXD); err != nil {
		return fmt.Errorf("set %s: %w", envXOXDToken, err)
	}
	if err := os.Setenv(envUsersCache, usersCachePath); err != nil {
		return fmt.Errorf("set %s: %w", envUsersCache, err)
	}
	if err := os.Setenv(envChannelsCache, channelsCachePath); err != nil {
		return fmt.Errorf("set %s: %w", envChannelsCache, err)
	}

	return fn()
}

type envValue struct {
	value   string
	present bool
}

func snapshotEnv(keys []string) map[string]envValue {
	values := make(map[string]envValue, len(keys))
	for _, key := range keys {
		value, present := os.LookupEnv(key)
		values[key] = envValue{value: value, present: present}
	}
	return values
}

func restoreEnv(values map[string]envValue) {
	for key, state := range values {
		if state.present {
			_ = os.Setenv(key, state.value)
			continue
		}
		_ = os.Unsetenv(key)
	}
}
