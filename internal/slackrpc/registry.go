package slackrpc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/korotovsky/slack-mcp-server/pkg/handler"
	"github.com/korotovsky/slack-mcp-server/pkg/provider"
)

type WorkspaceRuntime struct {
	WorkspaceKey      string
	Provider          *provider.ApiProvider
	Conversations     *handler.ConversationsHandler
	Channels          *handler.ChannelsHandler
	Ready             bool
	InitError         string
	TeamID            string
	EnterpriseID      string
	WorkspaceURL      string
	InitializedAtUnix int64
}

type WorkspaceStatus struct {
	WorkspaceKey      string `json:"workspace_key"`
	Ready             bool   `json:"ready"`
	InitError         string `json:"init_error,omitempty"`
	TeamID            string `json:"team_id,omitempty"`
	EnterpriseID      string `json:"enterprise_id,omitempty"`
	WorkspaceURL      string `json:"url,omitempty"`
	InitializedAtUnix int64  `json:"initialized_at_unix"`
}

type WorkspaceInitializer func(ctx context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error)

type WorkspaceRegistry struct {
	mu         sync.RWMutex
	entries    map[string]*WorkspaceRuntime
	order      []string
	defaultKey string
	frozen     bool
}

func NewWorkspaceRegistry() *WorkspaceRegistry {
	return &WorkspaceRegistry{
		entries: make(map[string]*WorkspaceRuntime),
		order:   make([]string, 0),
	}
}

func (r *WorkspaceRegistry) InitSequential(ctx context.Context, cfgs []WorkspaceConfig, initFn WorkspaceInitializer) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.frozen {
		return errors.New("workspace registry has already been initialized")
	}
	if len(cfgs) == 0 {
		return errors.New("workspace config list is empty")
	}

	for i, cfg := range cfgs {
		workspaceKey := strings.TrimSpace(cfg.WorkspaceKey)
		if workspaceKey == "" {
			return fmt.Errorf("workspaces[%d].workspace_key is required", i)
		}
		if _, exists := r.entries[workspaceKey]; exists {
			return fmt.Errorf("duplicate workspace_key: %s", workspaceKey)
		}

		runtime, err := initFn(ctx, cfg)
		if err != nil {
			runtime = &WorkspaceRuntime{
				WorkspaceKey:      workspaceKey,
				Ready:             false,
				InitError:         err.Error(),
				InitializedAtUnix: time.Now().Unix(),
			}
		}

		if runtime == nil {
			runtime = &WorkspaceRuntime{
				WorkspaceKey:      workspaceKey,
				Ready:             false,
				InitError:         "initializer returned nil runtime",
				InitializedAtUnix: time.Now().Unix(),
			}
		}

		r.entries[workspaceKey] = runtime
		r.order = append(r.order, workspaceKey)
		if r.defaultKey == "" {
			r.defaultKey = workspaceKey
		}
	}

	r.frozen = true

	if !r.anyReadyLocked() {
		return errors.New("no workspace initialized successfully")
	}

	return nil
}

func (r *WorkspaceRegistry) ResolveWorkspaceKey(candidate string) (string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		if r.defaultKey == "" {
			return "", errors.New("default workspace_key is not configured")
		}
		return r.defaultKey, nil
	}

	if _, ok := r.entries[candidate]; !ok {
		return "", fmt.Errorf("workspace_key not found: %s", candidate)
	}

	return candidate, nil
}

func (r *WorkspaceRegistry) Get(workspaceKey string) (*WorkspaceRuntime, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	runtime, ok := r.entries[workspaceKey]
	return runtime, ok
}

func (r *WorkspaceRegistry) ListStatuses() []WorkspaceStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()

	statuses := make([]WorkspaceStatus, 0, len(r.order))
	for _, key := range r.order {
		runtime := r.entries[key]
		statuses = append(statuses, WorkspaceStatus{
			WorkspaceKey:      runtime.WorkspaceKey,
			Ready:             runtime.Ready,
			InitError:         runtime.InitError,
			TeamID:            runtime.TeamID,
			EnterpriseID:      runtime.EnterpriseID,
			WorkspaceURL:      runtime.WorkspaceURL,
			InitializedAtUnix: runtime.InitializedAtUnix,
		})
	}

	return statuses
}

func (r *WorkspaceRegistry) anyReadyLocked() bool {
	for _, runtime := range r.entries {
		if runtime.Ready {
			return true
		}
	}
	return false
}
