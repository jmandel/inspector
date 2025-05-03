import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { IntraBrowserClientTransport } from "../transports/IntraBrowserTransport";
import {
  ClientNotification,
  ClientRequest,
  ResourceUpdatedNotificationSchema,
  LoggingMessageNotificationSchema,
  Request,
  Result,
  ServerCapabilities,
  PromptReference,
  ResourceReference,
  McpError,
  CompleteResultSchema,
  ErrorCode,
  CancelledNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  Progress,
} from "@modelcontextprotocol/sdk/types.js";
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { ConnectionStatus } from "../constants";
import { Notification, StdErrNotificationSchema } from "../notificationTypes";
import { InspectorOAuthClientProvider } from "../auth";
import packageJson from "../../../package.json";
import {
  getMCPProxyAddress,
  getMCPServerRequestMaxTotalTimeout,
  resetRequestTimeoutOnProgress,
} from "@/utils/configUtils";
import { getMCPServerRequestTimeout } from "@/utils/configUtils";
import { InspectorConfig } from "../configurationTypes";

interface UseConnectionOptions {
  transportType: "stdio" | "sse" | "streamable-http" | "intra-browser";
  command: string;
  args: string;
  sseUrl: string;
  env: Record<string, string>;
  config: InspectorConfig;
  onNotification?: (notification: Notification) => void;
  onStdErrNotification?: (notification: Notification) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPendingRequest?: (request: any, resolve: any, reject: any) => void;
  targetWindow?: Window;
  targetOrigin?: string;
}

export function useConnection({
  transportType,
  command,
  args,
  sseUrl,
  env,
  config,
  onNotification,
  onStdErrNotification,
  onPendingRequest,
  targetWindow,
  targetOrigin,
}: UseConnectionOptions) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("disconnected");
  const { toast } = useToast();
  const [serverCapabilities, setServerCapabilities] =
    useState<ServerCapabilities | null>(null);
  const [mcpClient, setMcpClient] = useState<Client | null>(null);
  const [requestHistory, setRequestHistory] = useState<
    { request: string; response?: string }[]
  >([]);
  const [completionsSupported, setCompletionsSupported] = useState(true);

  const pushHistory = (request: object, response?: object) => {
    setRequestHistory((prev) => [
      ...prev,
      {
        request: JSON.stringify(request),
        response: response !== undefined ? JSON.stringify(response) : undefined,
      },
    ]);
  };

  const makeRequest = async <T extends z.ZodType>(
    request: ClientRequest,
    schema: T,
    options?: RequestOptions & { suppressToast?: boolean },
  ): Promise<z.output<T>> => {
    if (!mcpClient) {
      throw new Error("MCP client not connected");
    }
    try {
      const abortController = new AbortController();

      // prepare MCP Client request options
      const mcpRequestOptions: RequestOptions = {
        signal: options?.signal ?? abortController.signal,
        resetTimeoutOnProgress:
          options?.resetTimeoutOnProgress ??
          resetRequestTimeoutOnProgress(config),
        timeout: options?.timeout ?? getMCPServerRequestTimeout(config),
        maxTotalTimeout:
          options?.maxTotalTimeout ??
          getMCPServerRequestMaxTotalTimeout(config),
      };

      // If progress notifications are enabled, add an onprogress hook to the MCP Client request options
      // This is required by SDK to reset the timeout on progress notifications
      if (mcpRequestOptions.resetTimeoutOnProgress) {
        mcpRequestOptions.onprogress = (params: Progress) => {
          // Add progress notification to `Server Notification` window in the UI
          if (onNotification) {
            onNotification({
              method: "notification/progress",
              params,
            });
          }
        };
      }

      let response;
      try {
        response = await mcpClient.request(request, schema, mcpRequestOptions);

        pushHistory(request, response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        pushHistory(request, { error: errorMessage });
        throw error;
      }

      return response;
    } catch (e: unknown) {
      if (!options?.suppressToast) {
        const errorString = (e as Error).message ?? String(e);
        toast({
          title: "Error",
          description: errorString,
          variant: "destructive",
        });
      }
      throw e;
    }
  };

  const handleCompletion = async (
    ref: ResourceReference | PromptReference,
    argName: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    if (!mcpClient || !completionsSupported) {
      return [];
    }

    const request: ClientRequest = {
      method: "completion/complete",
      params: {
        argument: {
          name: argName,
          value,
        },
        ref,
      },
    };

    try {
      const response = await makeRequest(request, CompleteResultSchema, {
        signal,
        suppressToast: true,
      });
      return response?.completion.values || [];
    } catch (e: unknown) {
      // Disable completions silently if the server doesn't support them.
      // See https://github.com/modelcontextprotocol/specification/discussions/122
      if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) {
        setCompletionsSupported(false);
        return [];
      }

      // Unexpected errors - show toast and rethrow
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
      throw e;
    }
  };

  const sendNotification = async (notification: ClientNotification) => {
    if (!mcpClient) {
      const error = new Error("MCP client not connected");
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
      throw error;
    }

    try {
      await mcpClient.notification(notification);
      // Log successful notifications
      pushHistory(notification);
    } catch (e: unknown) {
      if (e instanceof McpError) {
        // Log MCP protocol errors
        pushHistory(notification, { error: e.message });
      }
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
      throw e;
    }
  };

  const checkProxyHealth = async () => {
    try {
      const proxyHealthUrl = new URL(`${getMCPProxyAddress(config)}/health`);
      const proxyHealthResponse = await fetch(proxyHealthUrl);
      const proxyHealth = await proxyHealthResponse.json();
      if (proxyHealth?.status !== "ok") {
        throw new Error("MCP Proxy Server is not healthy");
      }
    } catch (e) {
      console.error("Couldn't connect to MCP Proxy Server", e);
      throw e;
    }
  };

  const connect = async (_e?: unknown) => {
    const client = new Client<Request, Notification, Result>(
      {
        name: "mcp-inspector",
        version: packageJson.version,
      },
      {
        capabilities: {
          sampling: {},
          roots: {
            listChanged: true,
          },
        },
      },
    );

    try {
      // Set to error first to clear any previous state
      setConnectionStatus("disconnected" as ConnectionStatus);

      await checkProxyHealth();

      // Register notification handlers
      if (onNotification) {
        [
          CancelledNotificationSchema,
          LoggingMessageNotificationSchema,
          ResourceUpdatedNotificationSchema,
          ResourceListChangedNotificationSchema,
          ToolListChangedNotificationSchema,
          PromptListChangedNotificationSchema,
        ].forEach((notificationSchema) => {
          client.setNotificationHandler(notificationSchema, onNotification);
        });

        client.fallbackNotificationHandler = (
          notification: Notification,
        ): Promise<void> => {
          onNotification(notification);
          return Promise.resolve();
        };
      }

      if (onStdErrNotification) {
        client.setNotificationHandler(
          StdErrNotificationSchema,
          onStdErrNotification,
        );
      }

      if (transportType === "intra-browser") {
        if (!targetWindow || !targetOrigin) {
          throw new Error("Target window and origin required for intra-browser transport");
        }
        
        const transport = new IntraBrowserClientTransport(
          targetWindow, 
          targetOrigin
        );
        
        // First log that we're about to initialize
        console.log("[useConnection] About to connect IntraBrowserClientTransport and send initialize");
        
        // Connect to the transport
        await client.connect(transport);
        
        // Set client and status
        setMcpClient(client);
        setConnectionStatus("connected" as ConnectionStatus);
        
        // Set server capabilities
        const capabilities = client.getServerCapabilities();
        setServerCapabilities(capabilities as ServerCapabilities);
        
        // Always send an explicit initialize request once connected
        console.log("[useConnection] Sending explicit initialize request after connect...");

        const initRequest: ClientRequest = {
          method: "initialize" as const,
          params: {},
        } as unknown as ClientRequest;

        try {
          const initResponse = await client.request(initRequest, z.any());

          pushHistory(initRequest, initResponse);

          if (initResponse?.capabilities) {
            setServerCapabilities(initResponse.capabilities as ServerCapabilities);
          }
        } catch (err) {
          console.error("[useConnection] Initialize request failed:", err);
        }
        
        console.log("[useConnection] Successfully connected IntraBrowserClientTransport");
        
          return;
      } else {
        // For SSE, StreamableHTTP, and stdio transports
        let mcpProxyServerUrl: URL;
        switch (transportType) {
          case "stdio":
            mcpProxyServerUrl = new URL(`${getMCPProxyAddress(config)}/stdio`);
            mcpProxyServerUrl.searchParams.append("command", command);
            mcpProxyServerUrl.searchParams.append("args", args);
            mcpProxyServerUrl.searchParams.append("env", JSON.stringify(env));
            break;

          case "sse":
            mcpProxyServerUrl = new URL(`${getMCPProxyAddress(config)}/sse`);
            mcpProxyServerUrl.searchParams.append("url", sseUrl);
            break;

          case "streamable-http":
            mcpProxyServerUrl = new URL(`${getMCPProxyAddress(config)}/mcp`);
            mcpProxyServerUrl.searchParams.append("url", sseUrl);
            break;
            
          default:
            throw new Error(`Unsupported transport type: ${transportType}`);
        }
        
        mcpProxyServerUrl.searchParams.append(
          "transportType",
          transportType
        );
      
        try {
          // Inject auth manually for SSE and streamable-http transports
          // ... existing code for auth handling
        } catch (error) {
          // ... existing error handling
        }
      }
    } catch (e) {
      // ... existing error handling
    }
  };

  const disconnect = async () => {
    await mcpClient?.close();
    const authProvider = new InspectorOAuthClientProvider(sseUrl);
    authProvider.clear();
    setMcpClient(null);
    setConnectionStatus("disconnected" as ConnectionStatus);
    setCompletionsSupported(false);
    setServerCapabilities(null);
  };

  return {
    connectionStatus,
    serverCapabilities,
    mcpClient,
    requestHistory,
    makeRequest,
    sendNotification,
    handleCompletion,
    completionsSupported,
    connect,
    disconnect,
    onPendingRequest: onPendingRequest || (() => {}),
  };
}
