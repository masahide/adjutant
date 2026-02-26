package slackrpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/korotovsky/slack-mcp-server/pkg/provider"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"go.uber.org/zap"
)

type GatewayMCP struct {
	registry *WorkspaceRegistry
	logger   *zap.Logger
}

func NewHTTPHandler(registry *WorkspaceRegistry, logger *zap.Logger) http.Handler {
	mcpServer := server.NewMCPServer(
		"adjutant-slack-mcp-gateway",
		"0.1.0",
		server.WithToolCapabilities(true),
		server.WithRecovery(),
	)

	gateway := &GatewayMCP{registry: registry, logger: logger}
	gateway.registerTools(mcpServer)

	streamableHTTP := server.NewStreamableHTTPServer(
		mcpServer,
		server.WithEndpointPath("/mcp"),
	)

	mux := http.NewServeMux()
	mux.Handle("/mcp", streamableHTTP)
	mux.HandleFunc("/healthz", gateway.healthz)

	return mux
}

func (g *GatewayMCP) registerTools(mcpServer *server.MCPServer) {
	mcpServer.AddTool(mcp.NewTool("workspaces_list",
		mcp.WithDescription("List configured Slack workspaces and initialization state"),
		mcp.WithReadOnlyHintAnnotation(true),
	), g.handleWorkspacesList)

	mcpServer.AddTool(mcp.NewTool("users_list",
		mcp.WithDescription("List users from the selected workspace"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("workspace_key", mcp.Description("Optional workspace key. Defaults to the first configured workspace.")),
		mcp.WithNumber("limit", mcp.DefaultNumber(200)),
	), g.handleUsersList)

	mcpServer.AddTool(mcp.NewTool("channels_list",
		mcp.WithDescription("List channels from the selected workspace"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("workspace_key", mcp.Description("Optional workspace key. Defaults to the first configured workspace.")),
		mcp.WithString("sort", mcp.DefaultString("popularity")),
		mcp.WithString("channel_types", mcp.DefaultString("public_channel,private_channel")),
		mcp.WithString("cursor", mcp.DefaultString("")),
		mcp.WithNumber("limit", mcp.DefaultNumber(100)),
	), g.handleChannelsList)

	mcpServer.AddTool(mcp.NewTool("get_user_info",
		mcp.WithDescription("Get detailed user information by user_id"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("workspace_key", mcp.Description("Optional workspace key. Defaults to the first configured workspace.")),
		mcp.WithString("user_id", mcp.Required()),
	), g.handleGetUserInfo)

	mcpServer.AddTool(mcp.NewTool("get_channel_info",
		mcp.WithDescription("Get channel information by channel_id"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("workspace_key", mcp.Description("Optional workspace key. Defaults to the first configured workspace.")),
		mcp.WithString("channel_id", mcp.Required()),
	), g.handleGetChannelInfo)

	mcpServer.AddTool(mcp.NewTool("get_user_name_by_id",
		mcp.WithDescription("Resolve a user name from user_id"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("user_id", mcp.Required()),
		mcp.WithString("team_id"),
		mcp.WithString("channel_id"),
		mcp.WithString("routing_mode"),
		mcp.WithString("workspace_key"),
	), g.handleGetUserNameByID)

	mcpServer.AddTool(mcp.NewTool("get_channel_name_by_id",
		mcp.WithDescription("Resolve a channel name from channel_id"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("channel_id", mcp.Required()),
		mcp.WithString("team_id"),
		mcp.WithString("routing_mode"),
		mcp.WithString("workspace_key"),
	), g.handleGetChannelNameByID)

	mcpServer.AddTool(mcp.NewTool("search_messages",
		mcp.WithDescription("Search Slack messages using the vendor search handler"),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("workspace_key", mcp.Description("Optional workspace key. Defaults to the first configured workspace.")),
		mcp.WithString("query", mcp.Description("Alias of search_query")),
		mcp.WithString("search_query", mcp.Description("Vendor-native query field")),
		mcp.WithNumber("limit", mcp.DefaultNumber(20)),
		mcp.WithString("cursor", mcp.DefaultString("")),
		mcp.WithString("filter_in_channel"),
		mcp.WithString("filter_in_im_or_mpim"),
		mcp.WithString("filter_users_with"),
		mcp.WithString("filter_users_from"),
		mcp.WithString("filter_date_before"),
		mcp.WithString("filter_date_after"),
		mcp.WithString("filter_date_on"),
		mcp.WithString("filter_date_during"),
	), g.handleSearchMessages)

	mcpServer.AddTool(mcp.NewTool("post_message",
		mcp.WithDescription("Post a message using the vendor add-message handler"),
		mcp.WithDestructiveHintAnnotation(true),
		mcp.WithString("workspace_key", mcp.Description("Optional workspace key. Defaults to the first configured workspace.")),
		mcp.WithString("channel_id", mcp.Required()),
		mcp.WithString("text", mcp.Required()),
		mcp.WithString("thread_ts"),
		mcp.WithString("content_type", mcp.DefaultString("text/markdown")),
	), g.handlePostMessage)
}

func (g *GatewayMCP) healthz(w http.ResponseWriter, _ *http.Request) {
	statuses := g.registry.ListStatuses()
	readyCount := 0
	for _, status := range statuses {
		if status.Ready {
			readyCount++
		}
	}

	resp := map[string]any{
		"ok":                 readyCount > 0,
		"workspace_total":    len(statuses),
		"workspace_ready":    readyCount,
		"workspace_statuses": statuses,
	}

	statusCode := http.StatusOK
	if readyCount == 0 {
		statusCode = http.StatusServiceUnavailable
	}

	w.Header().Set("content-type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(resp)
}

func (g *GatewayMCP) handleWorkspacesList(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	statuses := g.registry.ListStatuses()
	return mcp.NewToolResultStructured(map[string]any{
		"workspaces": statuses,
	}, fmt.Sprintf("%d workspace(s)", len(statuses))), nil
}

func (g *GatewayMCP) handleUsersList(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	runtime, toolErr := g.resolveRuntime(request)
	if toolErr != nil {
		return toolErr, nil
	}

	ready, err := runtime.Provider.IsReady()
	if err != nil {
		return g.asToolError("api_error", fmt.Sprintf("provider readiness check failed: %v", err)), nil
	}
	if !ready {
		return g.asToolError("not_ready", "workspace provider is not ready"), nil
	}

	limit := request.GetInt("limit", 200)
	if limit <= 0 {
		limit = 200
	}
	if limit > 2000 {
		limit = 2000
	}

	type userSummary struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		RealName    string `json:"real_name,omitempty"`
		DisplayName string `json:"display_name,omitempty"`
		Email       string `json:"email,omitempty"`
		TeamID      string `json:"team_id,omitempty"`
		IsBot       bool   `json:"is_bot"`
		Deleted     bool   `json:"deleted"`
	}

	usersMap := runtime.Provider.ProvideUsersMap()
	users := make([]userSummary, 0, len(usersMap.Users))
	for _, user := range usersMap.Users {
		users = append(users, userSummary{
			ID:          user.ID,
			Name:        user.Name,
			RealName:    user.RealName,
			DisplayName: user.Profile.DisplayName,
			Email:       user.Profile.Email,
			TeamID:      user.TeamID,
			IsBot:       user.IsBot,
			Deleted:     user.Deleted,
		})
	}

	sort.Slice(users, func(i, j int) bool {
		return users[i].ID < users[j].ID
	})

	if len(users) > limit {
		users = users[:limit]
	}

	result := map[string]any{
		"workspace_key": runtime.WorkspaceKey,
		"count":         len(users),
		"users":         users,
	}
	return mcp.NewToolResultStructured(result, fmt.Sprintf("%d user(s)", len(users))), nil
}

func (g *GatewayMCP) handleChannelsList(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	runtime, toolErr := g.resolveRuntime(request)
	if toolErr != nil {
		return toolErr, nil
	}

	proxyReq := g.withoutWorkspaceFields(request)
	result, err := runtime.Channels.ChannelsHandler(ctx, proxyReq)
	if err != nil {
		return g.asToolError(classifyError(err), fmt.Sprintf("channels_list failed: %v", err)), nil
	}

	return result, nil
}

func (g *GatewayMCP) handleGetUserInfo(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	runtime, toolErr := g.resolveRuntime(request)
	if toolErr != nil {
		return toolErr, nil
	}

	userID := strings.TrimSpace(request.GetString("user_id", ""))
	if userID == "" {
		return g.asToolError("validation_error", "user_id is required"), nil
	}

	users, err := runtime.Provider.Slack().GetUsersInfo(userID)
	if err != nil {
		return g.asToolError(classifyError(err), fmt.Sprintf("get_user_info failed: %v", err)), nil
	}
	if users == nil || len(*users) == 0 {
		return g.asToolError("not_found", fmt.Sprintf("user not found: %s", userID)), nil
	}

	return mcp.NewToolResultStructured(map[string]any{
		"workspace_key": runtime.WorkspaceKey,
		"user":          (*users)[0],
	}, fmt.Sprintf("user found: %s", userID)), nil
}

func (g *GatewayMCP) handleGetChannelInfo(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	runtime, toolErr := g.resolveRuntime(request)
	if toolErr != nil {
		return toolErr, nil
	}

	channelID := strings.TrimSpace(request.GetString("channel_id", ""))
	if channelID == "" {
		return g.asToolError("validation_error", "channel_id is required"), nil
	}

	channel, ok := g.lookupChannel(runtime.Provider, channelID)
	if !ok {
		refreshCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		if err := runtime.Provider.RefreshChannels(refreshCtx); err != nil {
			return g.asToolError(classifyError(err), fmt.Sprintf("refresh channels failed: %v", err)), nil
		}
		channel, ok = g.lookupChannel(runtime.Provider, channelID)
	}
	if !ok {
		return g.asToolError("not_found", fmt.Sprintf("channel not found: %s", channelID)), nil
	}

	return mcp.NewToolResultStructured(map[string]any{
		"workspace_key": runtime.WorkspaceKey,
		"channel":       channel,
	}, fmt.Sprintf("channel found: %s", channelID)), nil
}

func (g *GatewayMCP) handleGetUserNameByID(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	runtime, toolErr := g.resolveRuntime(request)
	if toolErr != nil {
		return toolErr, nil
	}

	userID := strings.TrimSpace(request.GetString("user_id", ""))
	if userID == "" {
		return g.asToolError("validation_error", "user_id is required"), nil
	}

	usersMap := runtime.Provider.ProvideUsersMap()
	if user, ok := usersMap.Users[userID]; ok {
		name := strings.TrimSpace(user.Name)
		if name == "" {
			name = strings.TrimSpace(user.RealName)
		}
		if name != "" {
			return mcp.NewToolResultStructured(map[string]any{
				"user_id": userID,
				"name":    name,
				"source":  "memory_cache",
			}, fmt.Sprintf("resolved user: %s", name)), nil
		}
	}

	users, err := runtime.Provider.Slack().GetUsersInfo(userID)
	if err != nil {
		return g.asToolError(classifyError(err), fmt.Sprintf("get_user_name_by_id failed: %v", err)), nil
	}
	if users == nil || len(*users) == 0 {
		return g.asToolError("not_found", fmt.Sprintf("user not found: %s", userID)), nil
	}

	resolvedUser := (*users)[0]
	name := strings.TrimSpace(resolvedUser.Name)
	if name == "" {
		name = strings.TrimSpace(resolvedUser.RealName)
	}
	if name == "" {
		return g.asToolError("not_found", fmt.Sprintf("user name is empty: %s", userID)), nil
	}

	return mcp.NewToolResultStructured(map[string]any{
		"user_id": userID,
		"name":    name,
		"source":  "api_refresh",
	}, fmt.Sprintf("resolved user: %s", name)), nil
}

func (g *GatewayMCP) handleGetChannelNameByID(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	runtime, toolErr := g.resolveRuntime(request)
	if toolErr != nil {
		return toolErr, nil
	}

	channelID := strings.TrimSpace(request.GetString("channel_id", ""))
	if channelID == "" {
		return g.asToolError("validation_error", "channel_id is required"), nil
	}

	channel, ok := g.lookupChannel(runtime.Provider, channelID)
	source := "memory_cache"
	if !ok {
		refreshCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		if err := runtime.Provider.RefreshChannels(refreshCtx); err != nil {
			return g.asToolError(classifyError(err), fmt.Sprintf("refresh channels failed: %v", err)), nil
		}
		channel, ok = g.lookupChannel(runtime.Provider, channelID)
		source = "api_refresh"
	}
	if !ok {
		return g.asToolError("not_found", fmt.Sprintf("channel not found: %s", channelID)), nil
	}

	return mcp.NewToolResultStructured(map[string]any{
		"channel_id": channelID,
		"name":       channel.Name,
		"source":     source,
	}, fmt.Sprintf("resolved channel: %s", channel.Name)), nil
}

func (g *GatewayMCP) handleSearchMessages(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	runtime, toolErr := g.resolveRuntime(request)
	if toolErr != nil {
		return toolErr, nil
	}

	args := cloneArgs(request.GetArguments())
	if _, exists := args["search_query"]; !exists {
		if queryValue, ok := args["query"]; ok {
			args["search_query"] = queryValue
		}
	}

	if searchQuery, ok := args["search_query"].(string); !ok || strings.TrimSpace(searchQuery) == "" {
		return g.asToolError("validation_error", "query or search_query is required"), nil
	}

	proxyReq := g.withSanitizedArgs(request, args)
	result, err := runtime.Conversations.ConversationsSearchHandler(ctx, proxyReq)
	if err != nil {
		return g.asToolError(classifyError(err), fmt.Sprintf("search_messages failed: %v", err)), nil
	}

	return result, nil
}

func (g *GatewayMCP) handlePostMessage(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	runtime, toolErr := g.resolveRuntime(request)
	if toolErr != nil {
		return toolErr, nil
	}

	proxyReq := g.withoutWorkspaceFields(request)
	result, err := runtime.Conversations.ConversationsAddMessageHandler(ctx, proxyReq)
	if err != nil {
		return g.asToolError(classifyError(err), fmt.Sprintf("post_message failed: %v", err)), nil
	}

	return result, nil
}

func (g *GatewayMCP) resolveRuntime(request mcp.CallToolRequest) (*WorkspaceRuntime, *mcp.CallToolResult) {
	workspaceKey := strings.TrimSpace(request.GetString("workspace_key", ""))
	resolvedKey, err := g.registry.ResolveWorkspaceKey(workspaceKey)
	if err != nil {
		return nil, g.asToolError("not_found", err.Error())
	}

	runtime, exists := g.registry.Get(resolvedKey)
	if !exists {
		return nil, g.asToolError("not_found", fmt.Sprintf("workspace_key not found: %s", resolvedKey))
	}
	if runtime.InitError != "" {
		return nil, g.asToolError("auth_invalid", runtime.InitError)
	}
	if runtime.Provider == nil {
		return nil, g.asToolError("internal_error", fmt.Sprintf("workspace provider is nil: %s", resolvedKey))
	}
	if !runtime.Ready {
		return nil, g.asToolError("not_ready", fmt.Sprintf("workspace is not ready: %s", resolvedKey))
	}

	return runtime, nil
}

func (g *GatewayMCP) asToolError(code, message string) *mcp.CallToolResult {
	g.logger.Warn("tool call failed", zap.String("code", code), zap.String("message", message))
	result := mcp.NewToolResultStructured(map[string]any{
		"ok":      false,
		"code":    code,
		"message": message,
	}, message)
	result.IsError = true
	return result
}

func (g *GatewayMCP) withoutWorkspaceFields(request mcp.CallToolRequest) mcp.CallToolRequest {
	args := cloneArgs(request.GetArguments())
	delete(args, "workspace_key")
	delete(args, "routing_mode")
	return g.withSanitizedArgs(request, args)
}

func (g *GatewayMCP) withSanitizedArgs(request mcp.CallToolRequest, args map[string]any) mcp.CallToolRequest {
	copied := request
	copied.Params.Arguments = args
	return copied
}

func cloneArgs(args map[string]any) map[string]any {
	cloned := make(map[string]any, len(args))
	for key, value := range args {
		cloned[key] = value
	}
	return cloned
}

func classifyError(err error) string {
	if err == nil {
		return "api_error"
	}

	if err == provider.ErrUsersNotReady || err == provider.ErrChannelsNotReady {
		return "not_ready"
	}

	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "invalid_auth"), strings.Contains(message, "not_authed"), strings.Contains(message, "authentication"):
		return "auth_invalid"
	case strings.Contains(message, "rate_limited"), strings.Contains(message, "too_many_requests"):
		return "rate_limited"
	case strings.Contains(message, "not found"):
		return "not_found"
	default:
		return "api_error"
	}
}

func (g *GatewayMCP) lookupChannel(apiProvider *provider.ApiProvider, channelID string) (provider.Channel, bool) {
	channelsMap := apiProvider.ProvideChannelsMaps()
	if channel, ok := channelsMap.Channels[channelID]; ok {
		return channel, true
	}

	if byNameID, ok := channelsMap.ChannelsInv[channelID]; ok {
		if channel, found := channelsMap.Channels[byNameID]; found {
			return channel, true
		}
	}

	return provider.Channel{}, false
}
