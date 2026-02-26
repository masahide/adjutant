package slackrpc

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	defaultListenAddr = ":8080"
	defaultLogLevel   = "info"
)

type Config struct {
	Listen     string            `json:"listen" yaml:"listen"`
	LogLevel   string            `json:"log_level" yaml:"log_level"`
	Workspaces []WorkspaceConfig `json:"workspaces" yaml:"workspaces"`
}

type WorkspaceConfig struct {
	WorkspaceKey string `json:"workspace_key" yaml:"workspace_key"`
	XOXC         string `json:"xoxc" yaml:"xoxc"`
	XOXD         string `json:"xoxd" yaml:"xoxd"`
	CacheDir     string `json:"cache_dir,omitempty" yaml:"cache_dir,omitempty"`
}

func LoadConfig(path string) (*Config, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("config path is required")
	}

	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{}
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".yaml", ".yml":
		if err := yaml.Unmarshal(payload, cfg); err != nil {
			return nil, fmt.Errorf("parse yaml config: %w", err)
		}
	default:
		if err := json.Unmarshal(payload, cfg); err != nil {
			if yErr := yaml.Unmarshal(payload, cfg); yErr != nil {
				return nil, fmt.Errorf("parse config as json (%v) or yaml (%v)", err, yErr)
			}
		}
	}

	cfg.applyDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return cfg, nil
}

func (c *Config) applyDefaults() {
	if c.Listen == "" {
		c.Listen = defaultListenAddr
	}
	if c.LogLevel == "" {
		c.LogLevel = defaultLogLevel
	}
}

func (c *Config) Validate() error {
	if len(c.Workspaces) == 0 {
		return errors.New("workspaces must contain at least one item")
	}

	seen := make(map[string]struct{}, len(c.Workspaces))
	for i, ws := range c.Workspaces {
		if strings.TrimSpace(ws.WorkspaceKey) == "" {
			return fmt.Errorf("workspaces[%d].workspace_key is required", i)
		}
		if strings.TrimSpace(ws.XOXC) == "" {
			return fmt.Errorf("workspaces[%d].xoxc is required", i)
		}
		if strings.TrimSpace(ws.XOXD) == "" {
			return fmt.Errorf("workspaces[%d].xoxd is required", i)
		}

		key := strings.TrimSpace(ws.WorkspaceKey)
		if _, exists := seen[key]; exists {
			return fmt.Errorf("duplicate workspace_key: %s", key)
		}
		seen[key] = struct{}{}
	}

	return nil
}
