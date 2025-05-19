import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IntraBrowserClientTransport } from "../../index.js"
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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
import { useState, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { ConnectionStatus } from "../constants";
import { Notification, StdErrNotificationSchema } from "../notificationTypes";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { InspectorOAuthClientProvider } from "../auth";
import packageJson from "../../../package.json";
import {
  getMCPProxyAddress,
  getMCPServerRequestMaxTotalTimeout,
  resetRequestTimeoutOnProgress,
} from "@/utils/configUtils";
import { getMCPServerRequestTimeout } from "@/utils/configUtils";
import { InspectorConfig } from "../configurationTypes";
import {
  CreateMessageRequestSchema,
  ListRootsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

interface UseConnectionOptions {
  transportType: "stdio" | "sse" | "streamable-http" | "intra-browser";
  command: string;
  args: string;
  sseUrl: string;
  env: Record<string, string>;
  bearerToken?: string;
  headerName?: string;
  config: InspectorConfig;
  onNotification?: (notification: Notification) => void;
  onStdErrNotification?: (notification: Notification) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onPendingRequest?: (request: any, resolve: any, reject: any) => void;
  // iframeSrc?: string; <-- REMOVED
  // targetOrigin?: string; <-- REMOVED
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRoots?: () => any[];
}

export function useConnection({
  transportType,
  command,
  args,
  sseUrl,
  env,
  bearerToken,
  headerName,
  config,
  onNotification,
  onStdErrNotification,
  onPendingRequest,
  // iframeSrc, <-- REMOVED
  // targetOrigin, <-- REMOVED
  getRoots,
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
  const pendingTransportRef = useRef<Transport | null>(null);

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

  const handleAuthError = async (error: unknown) => {
    if (error instanceof SseError && error.code === 401) {
      // Create a new auth provider with the current server URL
      const serverAuthProvider = new InspectorOAuthClientProvider(sseUrl);

      const result = await auth(serverAuthProvider, { serverUrl: sseUrl });
      return result === "AUTHORIZED";
    }

    return false;
  };

  // Modified connect signature to accept optional providerUrl
  const connect = async (providerUrl?: string, retryCount: number = 0) => {
    // Clear previous client/state if any
    if (mcpClient) {
      await disconnect();
    }
    setConnectionStatus("connecting");
    pendingTransportRef.current = null;

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

    let transport: Transport | null = null;

    try {
      // Proxy health check...
      try {
        await checkProxyHealth();
      } catch {
        if (transportType !== "intra-browser") {
           setConnectionStatus("error-connecting-to-proxy");
           return;
        }
      }

      // Register notification handlers...
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

      // Create Transport based on type
      if (transportType === "intra-browser") {
        if (!providerUrl) {
          throw new Error("providerUrl is required for intra-browser transport connection attempt.");
        }
        let iframeSrc: string;
        let targetOrigin: string;
        try {
          const url = new URL(providerUrl);
          iframeSrc = url.toString();
          targetOrigin = url.origin;
        } catch (e) {
          throw new Error(`Invalid provider URL: ${providerUrl}`);
        }
        console.log("[useConnection] Creating IntraBrowserClientTransport with:", { iframeSrc, targetOrigin });
        transport = new IntraBrowserClientTransport(iframeSrc, targetOrigin);
        pendingTransportRef.current = transport;
        console.log("[useConnection] IntraBrowserClientTransport instance created:", transport);
      } else {
        // Logic for stdio, sse, streamable-http transport creation...
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
        mcpProxyServerUrl.searchParams.append("transportType", transportType);

        const headers: HeadersInit = {};
        const serverAuthProvider = new InspectorOAuthClientProvider(sseUrl);
        const token = bearerToken || (await serverAuthProvider.tokens())?.access_token;
        if (token) {
          const authHeaderName = headerName || "Authorization";
          headers[authHeaderName] = `Bearer ${token}`;
        }

        const transportOptions = {
          eventSourceInit: { fetch: (url: string | URL | globalThis.Request, init: RequestInit | undefined) => fetch(url, { ...init, headers }) },
          requestInit: { headers },
        };

        transport = transportType === "streamable-http"
          ? new StreamableHTTPClientTransport(mcpProxyServerUrl, { sessionId: undefined })
          : new SSEClientTransport(mcpProxyServerUrl, transportOptions);
        pendingTransportRef.current = transport;
      }

      // Connect using the created transport
      if (!transport) {
        throw new Error("Transport creation failed.");
      }

      console.log(`[useConnection] Calling client.connect(transport) for ${transportType}...`);
      await client.connect(transport);
      pendingTransportRef.current = null;
      console.log(`[useConnection] client.connect(transport) returned successfully for ${transportType}.`);

      setMcpClient(client);
      setConnectionStatus("connected");
      setCompletionsSupported(true);

      // Get and set server capabilities
      const capabilities = client.getServerCapabilities();
      setServerCapabilities(capabilities as ServerCapabilities);

      // If intra-browser, send explicit initialize request *after* connect succeeds
      if (transportType === "intra-browser") {
            console.log("[useConnection] Sending explicit initialize request after connect...");
            const initRequest: ClientRequest = {
              method: "initialize" as const,
              params: {
                 protocolVersion: "2025-03-26",
                 capabilities: { roots: { listChanged: true } },
                 clientInfo: { name: "Inspector", version: packageJson.version }
               },
            } as unknown as ClientRequest;

            try {
              const initResponse = await client.request(initRequest, z.any());
              pushHistory(initRequest, initResponse);
              if (initResponse?.capabilities) {
                 // Update capabilities again if server sends different ones in initialize response
                 setServerCapabilities(initResponse.capabilities as ServerCapabilities);
              }
            } catch (err) {
              console.error("[useConnection] Explicit Initialize request failed:", err);
              // Decide if this is fatal? Maybe just log and continue.
            }
             console.log("[useConnection] Successfully connected IntraBrowserClientTransport");
      } else {
            // Log the implicit initialize for other transports
            pushHistory({ method: "initialize" }, {
              capabilities,
              serverInfo: client.getServerVersion(),
              instructions: client.getInstructions(),
            });
      }

      // Register request handlers (if provided) *after* connection
      if (onPendingRequest) {
        client.setRequestHandler(CreateMessageRequestSchema, (request) => {
          return new Promise((resolve, reject) => {
            onPendingRequest(request, resolve, reject);
          });
        });
      }
      if (getRoots) {
        client.setRequestHandler(ListRootsRequestSchema, async () => {
          return { roots: getRoots() };
        });
      }

    } catch (error) {
      pendingTransportRef.current = null;
      console.error(`[useConnection] Connection failed for ${transportType}:`, error);

      // Handle auth errors specifically for SSE/StreamableHTTP
      if (transportType === "sse" || transportType === "streamable-http") {
          const shouldRetry = await handleAuthError(error);
          if (shouldRetry) {
            // Recursively call connect (pass providerUrl if it was intra-browser originally)
            return connect(transportType === "intra-browser" ? providerUrl : undefined, retryCount + 1);
          }
          if (error instanceof SseError && error.code === 401) {
            setConnectionStatus("disconnected");
            return;
          }
      }

      // For general errors or auth errors we don't retry
      toast({ title: "Connection Error", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
      setConnectionStatus("error");
      await transport?.close().catch(e => console.warn("Error closing transport after connection failure:", e));

    }
  };

  const disconnect = async () => {
    const currentStatus = connectionStatus;
    const transportToClose = pendingTransportRef.current;
    pendingTransportRef.current = null;

    console.log(`[useConnection] disconnect called. Status: ${currentStatus}`);

    if (mcpClient) {
        console.log("[useConnection] Closing established MCP client...");
        await mcpClient.close().catch(e => console.warn("Error closing MCP client:", e));
        setMcpClient(null);
    }

    if (currentStatus === "connecting" && transportToClose) {
        console.log("[useConnection] Closing pending transport explicitly...");
        await transportToClose.close().catch(e => console.warn("Error closing pending transport:", e));
    }

    if (transportType === "sse" || transportType === "streamable-http") {
        const authProvider = new InspectorOAuthClientProvider(sseUrl);
        authProvider.clear();
    }

    setConnectionStatus("disconnected");
    setCompletionsSupported(false);
    setServerCapabilities(null);
    console.log("[useConnection] Disconnect completed.");
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
