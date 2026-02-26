package slackrpc

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnvBootstrapperWithWorkspaceEnvRestoresState(t *testing.T) {
	t.Setenv(envXOXPToken, "keep-xoxp")
	t.Setenv(envXOXBToken, "keep-xoxb")
	t.Setenv(envXOXCToken, "keep-xoxc")
	t.Setenv(envXOXDToken, "keep-xoxd")
	t.Setenv(envUsersCache, "/tmp/original-users")
	t.Setenv(envChannelsCache, "/tmp/original-channels")

	bootstrapper := NewEnvBootstrapper()
	cfg := WorkspaceConfig{
		WorkspaceKey: "acme",
		XOXC:         "xoxc-acme",
		XOXD:         "xoxd-acme",
		CacheDir:     t.TempDir(),
	}

	if err := bootstrapper.WithWorkspaceEnv(cfg, func() error {
		if got := os.Getenv(envXOXPToken); got != "" {
			t.Fatalf("%s = %q, want empty", envXOXPToken, got)
		}
		if got := os.Getenv(envXOXBToken); got != "" {
			t.Fatalf("%s = %q, want empty", envXOXBToken, got)
		}
		if got := os.Getenv(envXOXCToken); got != "xoxc-acme" {
			t.Fatalf("%s = %q, want xoxc-acme", envXOXCToken, got)
		}
		if got := os.Getenv(envXOXDToken); got != "xoxd-acme" {
			t.Fatalf("%s = %q, want xoxd-acme", envXOXDToken, got)
		}

		expectedUsers := filepath.Join(cfg.CacheDir, "users_cache.json")
		expectedChannels := filepath.Join(cfg.CacheDir, "channels_cache_v2.json")
		if got := os.Getenv(envUsersCache); got != expectedUsers {
			t.Fatalf("%s = %q, want %q", envUsersCache, got, expectedUsers)
		}
		if got := os.Getenv(envChannelsCache); got != expectedChannels {
			t.Fatalf("%s = %q, want %q", envChannelsCache, got, expectedChannels)
		}

		return nil
	}); err != nil {
		t.Fatalf("WithWorkspaceEnv returned error: %v", err)
	}

	if got := os.Getenv(envXOXPToken); got != "keep-xoxp" {
		t.Fatalf("%s = %q, want keep-xoxp", envXOXPToken, got)
	}
	if got := os.Getenv(envXOXBToken); got != "keep-xoxb" {
		t.Fatalf("%s = %q, want keep-xoxb", envXOXBToken, got)
	}
	if got := os.Getenv(envXOXCToken); got != "keep-xoxc" {
		t.Fatalf("%s = %q, want keep-xoxc", envXOXCToken, got)
	}
	if got := os.Getenv(envXOXDToken); got != "keep-xoxd" {
		t.Fatalf("%s = %q, want keep-xoxd", envXOXDToken, got)
	}
	if got := os.Getenv(envUsersCache); got != "/tmp/original-users" {
		t.Fatalf("%s = %q, want /tmp/original-users", envUsersCache, got)
	}
	if got := os.Getenv(envChannelsCache); got != "/tmp/original-channels" {
		t.Fatalf("%s = %q, want /tmp/original-channels", envChannelsCache, got)
	}
}
