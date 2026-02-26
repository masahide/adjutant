package slackrpc

import (
	"context"
	"errors"
	"fmt"
	"net/url"
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
	AuthTest          *AuthTestIdentity
	InitializedAtUnix int64
}

type WorkspaceStatus struct {
	WorkspaceKey      string            `json:"workspace_key"`
	Ready             bool              `json:"ready"`
	InitError         string            `json:"init_error,omitempty"`
	TeamID            string            `json:"team_id,omitempty"`
	EnterpriseID      string            `json:"enterprise_id,omitempty"`
	WorkspaceURL      string            `json:"url,omitempty"`
	AuthTest          *AuthTestIdentity `json:"auth_test,omitempty"`
	InitializedAtUnix int64             `json:"initialized_at_unix"`
}

type AuthTestIdentity struct {
	URL          string `json:"url,omitempty"`
	Team         string `json:"team,omitempty"`
	User         string `json:"user,omitempty"`
	TeamID       string `json:"team_id,omitempty"`
	UserID       string `json:"user_id,omitempty"`
	EnterpriseID string `json:"enterprise_id,omitempty"`
	BotID        string `json:"bot_id,omitempty"`
}

type WorkspaceInitializer func(ctx context.Context, cfg WorkspaceConfig) (*WorkspaceRuntime, error)

var (
	ErrWorkspaceAlreadyExists = errors.New("workspace_key already exists")
	ErrWorkspaceNotFound      = errors.New("workspace_key not found")
)

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

	return nil
}

func (r *WorkspaceRegistry) Register(ctx context.Context, cfg WorkspaceConfig, initFn WorkspaceInitializer) (*WorkspaceRuntime, error) {
	workspaceKey := strings.TrimSpace(cfg.WorkspaceKey)
	if strings.TrimSpace(cfg.XOXC) == "" {
		return nil, errors.New("xoxc is required")
	}
	if strings.TrimSpace(cfg.XOXD) == "" {
		return nil, errors.New("xoxd is required")
	}

	if workspaceKey != "" {
		r.mu.Lock()
		if _, exists := r.entries[workspaceKey]; exists {
			r.mu.Unlock()
			return nil, fmt.Errorf("%w: %s", ErrWorkspaceAlreadyExists, workspaceKey)
		}
		r.mu.Unlock()
	}

	cfgForInit := cfg
	if workspaceKey == "" {
		cfgForInit.WorkspaceKey = fmt.Sprintf("__auto_workspace_%d", time.Now().UnixNano())
	}

	runtime, err := initFn(ctx, cfgForInit)
	if err != nil {
		return nil, err
	}
	if runtime == nil {
		return nil, errors.New("initializer returned nil runtime")
	}
	if !runtime.Ready {
		return nil, errors.New("initializer returned not-ready runtime")
	}

	resolvedWorkspaceKey := workspaceKey
	if resolvedWorkspaceKey == "" {
		resolvedWorkspaceKey = deriveWorkspaceKey(runtime)
	}
	resolvedWorkspaceKey = strings.TrimSpace(resolvedWorkspaceKey)
	if resolvedWorkspaceKey == "" {
		return nil, errors.New("workspace_key could not be derived from auth.test")
	}
	runtime.WorkspaceKey = resolvedWorkspaceKey

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.entries[resolvedWorkspaceKey]; exists {
		return nil, fmt.Errorf("%w: %s", ErrWorkspaceAlreadyExists, resolvedWorkspaceKey)
	}
	r.entries[resolvedWorkspaceKey] = runtime
	r.order = append(r.order, resolvedWorkspaceKey)
	if r.defaultKey == "" {
		r.defaultKey = resolvedWorkspaceKey
	}

	return runtime, nil
}

func (r *WorkspaceRegistry) Unregister(workspaceKey string) (*WorkspaceRuntime, error) {
	key := strings.TrimSpace(workspaceKey)
	if key == "" {
		return nil, errors.New("workspace_key is required")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	runtime, exists := r.entries[key]
	if !exists {
		return nil, fmt.Errorf("%w: %s", ErrWorkspaceNotFound, key)
	}

	delete(r.entries, key)
	for i, current := range r.order {
		if current == key {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}

	if r.defaultKey == key {
		r.defaultKey = ""
		for _, candidate := range r.order {
			if _, ok := r.entries[candidate]; ok {
				r.defaultKey = candidate
				break
			}
		}
	}

	return runtime, nil
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
			AuthTest:          runtime.AuthTest,
			InitializedAtUnix: runtime.InitializedAtUnix,
		})
	}

	return statuses
}

func deriveWorkspaceKey(runtime *WorkspaceRuntime) string {
	if runtime == nil {
		return ""
	}

	enterpriseID := strings.TrimSpace(runtime.EnterpriseID)
	if enterpriseID != "" {
		return enterpriseID
	}

	teamID := strings.TrimSpace(runtime.TeamID)
	if teamID != "" {
		return teamID
	}

	urlAlias := workspaceAliasFromURL(runtime.WorkspaceURL)
	if urlAlias != "" {
		return urlAlias
	}

	return strings.TrimSpace(runtime.WorkspaceKey)
}

func workspaceAliasFromURL(rawURL string) string {
	normalized := strings.TrimSpace(rawURL)
	if normalized == "" {
		return ""
	}

	parsed, err := url.Parse(normalized)
	if err != nil || parsed == nil {
		return ""
	}
	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if host == "" {
		return ""
	}
	parts := strings.Split(host, ".")
	if len(parts) < 3 {
		return ""
	}
	if parts[len(parts)-2] != "slack" || parts[len(parts)-1] != "com" {
		return ""
	}

	candidate := strings.TrimSpace(parts[0])
	switch candidate {
	case "", "app", "edgeapi", "hooks":
		return ""
	default:
		return candidate
	}
}
