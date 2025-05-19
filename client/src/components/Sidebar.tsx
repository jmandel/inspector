import { useState, useCallback, useRef } from "react";
import {
  Play,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Bug,
  Github,
  Eye,
  EyeOff,
  RotateCcw,
  Settings,
  HelpCircle,
  RefreshCwOff,
  Loader2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StdErrNotification } from "@/lib/notificationTypes";
import {
  LoggingLevel,
  LoggingLevelSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InspectorConfig } from "@/lib/configurationTypes";
import { ConnectionStatus } from "@/lib/constants";
import useTheme from "../lib/useTheme";
import { version } from "../../../package.json";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { IntraBrowserClientTransport, UiCallbacks, SetupError, ServerSetupRequirements } from "../../../../src/IntraBrowserTransport";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Trash2 } from "lucide-react";

// --- New Setup Modal Helper (Protocol v2.0) ---

/** Represents the messages sent from the setup iframe */
interface SetupResultMessage {
    type: 'SERVER_SETUP_COMPLETE' | 'SERVER_SETUP_ABORT';
    success: boolean;
    code?: 'USER_CANCELED' | 'FAILED';
    reason?: string;
}

/**
 * Opens a modal iframe for the provider setup process (Protocol v2.0).
 * Resolves when the iframe posts SERVER_SETUP_COMPLETE.
 * Rejects if the iframe posts SERVER_SETUP_ABORT or on error.
 */
export async function setupModal(serverUrl: string): Promise<void> {
  let urlObj: URL;
  try {
    urlObj = new URL(serverUrl);
  } catch (e) {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  urlObj.searchParams.set('phase', 'setup');
  urlObj.searchParams.set('client', location.origin);

  return new Promise<void>((resolve, reject) => {
    console.log(`[setupModal] Opening setup modal for: ${urlObj.toString()}`);
    // 1 – overlay
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;' +
      'align-items:center;justify-content:center;';
    document.body.appendChild(overlay);

    // Optional: Close button on overlay
    const closeButton = document.createElement('button');
    closeButton.textContent = '✕';
    closeButton.style.cssText = 'position:absolute;top:20px;right:20px;background:none;border:none;font-size:1.5em;color:white;cursor:pointer;';
    closeButton.onclick = () => {
        console.log("[setupModal] Aborted by user clicking overlay close button.");
        cleanup(false, new Error('USER_CANCELED'));
    };
    overlay.appendChild(closeButton);

    // 2 – iframe
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:min(90%, 800px);height:min(90%, 600px);border:0;border-radius:8px;background:white;'; // Added background
    frame.src = urlObj.toString();
    overlay.appendChild(frame);

    // 3 – listen
    function handler(ev: MessageEvent) {
      // Validate source and origin
      if (ev.source !== frame.contentWindow || ev.origin !== urlObj.origin)
        return;

       const data = ev.data as SetupResultMessage;
        console.log("[setupModal] Received message:", data);

      switch (data?.type) {
        case 'SERVER_SETUP_COMPLETE':
          if (data.success === true) {
              cleanup(true); // Resolve promise
          } else {
              console.warn("[setupModal] Received SERVER_SETUP_COMPLETE but success was not true.");
              cleanup(false, new Error('Setup completed with unexpected success value'));
          }
          break;
        case 'SERVER_SETUP_ABORT':
           const errorCode = data.code || 'FAILED';
           const reason = data.reason || errorCode;
          cleanup(false, new Error(`${errorCode}: ${reason}`)); // Reject promise
          break;
      }
    }
    window.addEventListener('message', handler, false);

    function cleanup(ok: boolean, err?: Error) {
      console.log(`[setupModal] Cleaning up. Success: ${ok}`, err ? `Error: ${err.message}`: '');
      window.removeEventListener('message', handler);
      if (overlay.parentNode) {
          overlay.remove();
      }
      ok ? resolve() : reject(err);
    }

    // Handle iframe load errors
    frame.onerror = (event) => {
         console.error("[setupModal] Iframe failed to load:", event);
         cleanup(false, new Error(`Setup iframe failed to load for ${urlObj.origin}. Check URL and network.`));
    };
     frame.onload = () => {
         console.log("[setupModal] Iframe loaded.");
         // Check if contentWindow is accessible (might fail cross-origin)
         if (!frame.contentWindow) {
             console.error("[setupModal] Iframe contentWindow is inaccessible after load.");
             cleanup(false, new Error("Setup iframe context is inaccessible."));
         }
     };

  });
}

// --- End Setup Modal Helper ---


// --- Simplified IntraBrowserSetupPanel Component (Protocol v2.0) ---

interface IntraBrowserSetupPanelProps {
  configuredProviders: string[];
  addConfiguredProvider: (url: string) => void;
  removeConfiguredProvider: (url: string) => void;
  selectedProviderUrl: string;
  setSelectedProviderUrl: (url: string) => void;
  isConnected: boolean;
  onDisconnectClick: () => void;
}

const IntraBrowserSetupPanel: React.FC<IntraBrowserSetupPanelProps> = ({
  configuredProviders,
  addConfiguredProvider,
  removeConfiguredProvider,
  selectedProviderUrl,
  setSelectedProviderUrl,
  isConnected,
  onDisconnectClick
}) => {
  const [providerUrlToAdd, setProviderUrlToAdd] = useState("");
  const [isAddingProvider, setIsAddingProvider] = useState(false); // For spinner
  const { toast } = useToast();

  const handleAddProvider = useCallback(async () => {
    const url = providerUrlToAdd.trim();
    if (!url) {
        toast({ title: "Error", description: "Please enter a provider URL.", variant: "destructive" });
        return;
    }
    // Basic URL validation
    try {
        new URL(url);
    } catch {
        toast({ title: "Error", description: "Invalid provider URL format.", variant: "destructive" });
        return;
    }

    setIsAddingProvider(true);
    try {
        await setupModal(url);
        addConfiguredProvider(url);
        toast({ title: "Provider Added", description: `${new URL(url).hostname} is ready to connect.` });
        setProviderUrlToAdd(""); // Clear input on success
    } catch (err) {
         console.error("[SetupPanel] Setup modal failed:", err);
         const errorMsg = err instanceof Error ? err.message : String(err);
         // Don't show redundant toast if user cancelled
         if (!errorMsg.startsWith('USER_CANCELED')) {
             toast({ title: "Setup Failed", description: errorMsg, variant: "destructive" });
         }
    } finally {
        setIsAddingProvider(false);
    }
  }, [providerUrlToAdd, addConfiguredProvider, toast]);

  const handleReconfigure = useCallback(async (url: string) => {
      if (!url) return;
      console.log(`[SetupPanel] Reconfiguring provider: ${url}`);
      setIsAddingProvider(true); // Reuse loading state maybe?
      try {
          await setupModal(url);
          toast({ title: "Reconfiguration Complete", description: `${new URL(url).hostname} reconfigured successfully.` });
      } catch (err) {
          console.error("[SetupPanel] Reconfiguration failed:", err);
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (!errorMsg.startsWith('USER_CANCELED')) {
              toast({ title: "Reconfiguration Failed", description: errorMsg, variant: "destructive" });
          }
      } finally {
          setIsAddingProvider(false);
      }
  }, [toast]);

  const handleRemoveProvider = (url: string) => {
    removeConfiguredProvider(url);
    toast({ title: "Provider Removed", description: `${new URL(url).hostname} removed.` });
  };

  return (
    <div className="space-y-4">
      {/* Add New Provider Section */}
      <div className="space-y-2 border-b pb-4 mb-4 border-border">
        <label className="text-sm font-medium" htmlFor="provider-url-input">
          Add New Provider URL
        </label>
        <Input
          id="provider-url-input"
          placeholder="https://provider.example.com/tool.html"
          value={providerUrlToAdd}
          onChange={(e) => setProviderUrlToAdd(e.target.value)}
          disabled={isAddingProvider}
          className="font-mono"
        />
        <Button onClick={handleAddProvider} disabled={isAddingProvider || !providerUrlToAdd} className="w-full">
          {isAddingProvider && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Add / Configure Provider
        </Button>
         {isAddingProvider && (
             <Alert variant="default" className="mt-2">
                 <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                 <AlertTitle>Setup in Progress</AlertTitle>
                 <AlertDescription>Complete the steps in the setup panel...</AlertDescription>
             </Alert>
        )}
      </div>

      {/* Select/Connect/Remove Configured Provider Section */}
      <div className="space-y-2">
         <label className="text-sm font-medium" htmlFor="configured-provider-select">
            Connect to Configured Provider
        </label>
        {configuredProviders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No configured providers yet. Add one above.</p>
        ) : (
          <div className="space-y-2 mt-2 max-h-60 overflow-y-auto border rounded p-2">
            {configuredProviders.map(url => (
              <div key={url} className="flex items-center justify-between gap-2 p-1 hover:bg-accent rounded">
                <span
                  className={`text-sm truncate flex-grow cursor-pointer ${selectedProviderUrl === url ? 'font-semibold' : ''}`}
                  title={url}
                  onClick={() => setSelectedProviderUrl(url)}
                >
                  {url}
                </span>
                <div className="flex-shrink-0 space-x-1">
                  <Button
                     variant="ghost"
                     size="icon"
                     className="h-7 w-7 text-muted-foreground hover:text-foreground"
                     onClick={() => handleReconfigure(url)}
                     disabled={isAddingProvider || (isConnected && selectedProviderUrl === url)}
                     aria-label={`Reconfigure ${url}`}
                     title={`Reconfigure ${url}`}
                  >
                      <Settings className="h-4 w-4" />
                  </Button>
                   <Button
                     variant="ghost"
                     size="icon"
                     className="h-7 w-7 text-destructive hover:bg-destructive/10"
                     onClick={() => handleRemoveProvider(url)}
                     aria-label={`Remove ${url}`}
                     title={`Remove ${url}`}
                   >
                     <Trash2 className="h-4 w-4" />
                   </Button>
                 </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// --- End IntraBrowserSetupPanel Component ---


interface SidebarProps {
  connectionStatus: ConnectionStatus;
  transportType: "stdio" | "sse" | "streamable-http" | "intra-browser";
  setTransportType: (type: "stdio" | "sse" | "streamable-http" | "intra-browser") => void;
  command: string;
  setCommand: (command: string) => void;
  args: string;
  setArgs: (args: string) => void;
  sseUrl: string;
  setSseUrl: (url: string) => void;
  env: Record<string, string>;
  setEnv: (env: Record<string, string>) => void;
  bearerToken: string;
  setBearerToken: (token: string) => void;
  headerName?: string;
  setHeaderName?: (name: string) => void;
  onConnect: (providerUrl?: string) => void;
  onDisconnect: () => void;
  stdErrNotifications: StdErrNotification[];
  clearStdErrNotifications: () => void;
  logLevel: LoggingLevel;
  sendLogLevelRequest: (level: LoggingLevel) => void;
  loggingSupported: boolean;
  config: InspectorConfig;
  setConfig: (config: InspectorConfig) => void;
  configuredProviders: string[];
  addConfiguredProvider: (url: string) => void;
  removeConfiguredProvider: (url: string) => void;
  selectedProviderUrl: string;
  setSelectedProviderUrl: (url: string) => void;
}

const Sidebar = ({
  connectionStatus,
  transportType,
  setTransportType,
  command,
  setCommand,
  args,
  setArgs,
  sseUrl,
  setSseUrl,
  env,
  setEnv,
  bearerToken,
  setBearerToken,
  headerName,
  setHeaderName,
  onConnect,
  onDisconnect,
  stdErrNotifications,
  clearStdErrNotifications,
  logLevel,
  sendLogLevelRequest,
  loggingSupported,
  config,
  setConfig,
  configuredProviders,
  addConfiguredProvider,
  removeConfiguredProvider,
  selectedProviderUrl,
  setSelectedProviderUrl,
}: SidebarProps) => {
  const [theme, setTheme] = useTheme();
  const [showEnvVars, setShowEnvVars] = useState(false);
  const [showBearerToken, setShowBearerToken] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [shownEnvVars, setShownEnvVars] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  const connect = () => {
    if (connectionStatus === "connected") {
      console.log("[Sidebar] Reconnecting...");
      onDisconnect();
      setTimeout(() => {
         if (transportType === "intra-browser") {
           if (selectedProviderUrl) {
              console.log(`[Sidebar] Attempting to reconnect to selected provider: ${selectedProviderUrl}`);
              onConnect(selectedProviderUrl);
           } else {
              console.warn("[Sidebar] Reconnect clicked for intra-browser, but no provider selected.");
              toast({ title: "Cannot Reconnect", description: "No Intra-Browser provider selected.", variant: "destructive" });
           }
         } else {
           console.log(`[Sidebar] Attempting to reconnect for ${transportType}...`);
           onConnect();
         }
      }, 100);
      return;
    }

    if (connectionStatus === "disconnected" || connectionStatus === "error" || connectionStatus === "error-connecting-to-proxy") {
        if (transportType === "intra-browser") {
          if (selectedProviderUrl) {
            console.log(`[Sidebar] Attempting to connect to selected provider: ${selectedProviderUrl}`);
            onConnect(selectedProviderUrl);
          } else {
            console.warn("[Sidebar] Connect clicked for intra-browser, but no provider selected.");
            toast({ title: "Cannot Connect", description: "No Intra-Browser provider selected.", variant: "destructive" });
          }
        } else {
          console.log(`[Sidebar] Attempting to connect for ${transportType}...`);
          onConnect();
        }
    }
  };

  const getConnectButtonText = () => {
    if (connectionStatus === "connected") {
      return "Reconnect";
    }
    return "Connect";
  };

  const isConnectDisabled = () => {
      if (connectionStatus === 'connecting') return true;
      if (connectionStatus === 'connected') return false;
      if (transportType === 'intra-browser' && !selectedProviderUrl) {
          return true;
      }
      return false;
  };

  return (
    <div className="w-80 bg-card border-r border-border flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center">
          <h1 className="ml-2 text-lg font-semibold">
            MCP Inspector v{version}
          </h1>
        </div>
      </div>

      <div className="p-4 flex-1 overflow-auto">
        <div className="space-y-4">
          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="transport-type-select"
            >
              Transport Type
            </label>
            <Select
              value={transportType}
              onValueChange={(value: "stdio" | "sse" | "streamable-http" | "intra-browser") =>
                setTransportType(value)
              }
              disabled={connectionStatus === 'connecting' || connectionStatus === 'connected'}
            >
              <SelectTrigger id="transport-type-select">
                <SelectValue placeholder="Select transport type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">STDIO</SelectItem>
                <SelectItem value="sse">SSE</SelectItem>
                <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                <SelectItem value="intra-browser">postMessage</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(() => {
            const isConnected = connectionStatus === "connected";
            const isConnecting = connectionStatus === "connecting";

            if (transportType === "intra-browser") {
              return (
                <IntraBrowserSetupPanel
                    configuredProviders={configuredProviders}
                    addConfiguredProvider={addConfiguredProvider}
                    removeConfiguredProvider={removeConfiguredProvider}
                    selectedProviderUrl={selectedProviderUrl}
                    setSelectedProviderUrl={setSelectedProviderUrl}
                    isConnected={isConnected}
                    onDisconnectClick={onDisconnect}
                />
              );
            } else if (transportType === "stdio") {
              return (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="command-input">
                      Command
                    </label>
                    <Input
                      id="command-input"
                      placeholder="Command"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      className="font-mono"
                      disabled={isConnected || isConnecting}
                    />
                  </div>
                  <div className="space-y-2">
                    <label
                      className="text-sm font-medium"
                      htmlFor="arguments-input"
                    >
                      Arguments
                    </label>
                    <Input
                      id="arguments-input"
                      placeholder="Arguments (space-separated)"
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      className="font-mono"
                      disabled={isConnected || isConnecting}
                    />
                  </div>
                </>
              );
            } else {
              return (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium" htmlFor="sse-url-input">
                      URL
                    </label>
                    <Input
                      id="sse-url-input"
                      placeholder="URL"
                      value={sseUrl}
                      onChange={(e) => setSseUrl(e.target.value)}
                      className="font-mono"
                      disabled={isConnected || isConnecting}
                    />
                  </div>
                  <div className="space-y-2">
                    <Button
                      variant="outline"
                      onClick={() => setShowBearerToken(!showBearerToken)}
                      className="flex items-center w-full"
                      data-testid="auth-button"
                      aria-expanded={showBearerToken}
                       disabled={isConnected || isConnecting}
                    >
                      {showBearerToken ? (
                        <ChevronDown className="w-4 h-4 mr-2" />
                      ) : (
                        <ChevronRight className="w-4 h-4 mr-2" />
                      )}
                      Authentication
                    </Button>
                    {showBearerToken && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Header Name</label>
                        <Input
                          placeholder="Authorization"
                          onChange={(e) =>
                            setHeaderName && setHeaderName(e.target.value)
                          }
                          data-testid="header-input"
                          className="font-mono"
                          value={headerName}
                          disabled={isConnected || isConnecting}
                        />
                        <label
                          className="text-sm font-medium"
                          htmlFor="bearer-token-input"
                        >
                          Bearer Token
                        </label>
                        <Input
                          id="bearer-token-input"
                          placeholder="Bearer Token"
                          value={bearerToken}
                          onChange={(e) => setBearerToken(e.target.value)}
                          data-testid="bearer-token-input"
                          className="font-mono"
                          type="password"
                          disabled={isConnected || isConnecting}
                        />
                      </div>
                    )}
                  </div>
                </>
              );
            }
          })()}
          {transportType === "stdio" && (
            <div className="space-y-2">
              <Button
                variant="outline"
                onClick={() => setShowEnvVars(!showEnvVars)}
                className="flex items-center w-full"
                data-testid="env-vars-button"
                aria-expanded={showEnvVars}
                disabled={connectionStatus === 'connected' || connectionStatus === 'connecting'}
              >
                {showEnvVars ? <ChevronDown className="w-4 h-4 mr-2" /> : <ChevronRight className="w-4 h-4 mr-2" />}
                Environment Variables
              </Button>
              {showEnvVars && (
                <div className="space-y-2">
                  {Object.entries(env).map(([key, value], idx) => (
                    <div key={idx} className="space-y-2 pb-4">
                      <div className="flex gap-2">
                        <Input
                          aria-label={`Environment variable key ${idx + 1}`}
                          placeholder="Key"
                          value={key}
                          onChange={(e) => {
                            const newKey = e.target.value;
                            const newEnv = Object.entries(env).reduce(
                              (acc, [k, v]) => {
                                if (k === key) {
                                  acc[newKey] = value;
                                } else {
                                  acc[k] = v;
                                }
                                return acc;
                              },
                              {} as Record<string, string>,
                            );
                            setEnv(newEnv);
                            setShownEnvVars((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) {
                                next.delete(key);
                                next.add(newKey);
                              }
                              return next;
                            });
                          }}
                          className="font-mono"
                          disabled={connectionStatus === 'connected' || connectionStatus === 'connecting'}
                        />
                        <Button
                          variant="destructive"
                          size="icon"
                          className="h-9 w-9 p-0 shrink-0"
                          onClick={() => {
                            // eslint-disable-next-line @typescript-eslint/no-unused-vars
                            const { [key]: _removed, ...rest } = env;
                            setEnv(rest);
                          }}
                          disabled={connectionStatus === 'connected' || connectionStatus === 'connecting'}
                        >
                          ×
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Input
                          aria-label={`Environment variable value ${idx + 1}`}
                          type={shownEnvVars.has(key) ? "text" : "password"}
                          placeholder="Value"
                          value={value}
                          onChange={(e) => {
                            const newEnv = { ...env };
                            newEnv[key] = e.target.value;
                            setEnv(newEnv);
                          }}
                          className="font-mono"
                          disabled={connectionStatus === 'connected' || connectionStatus === 'connecting'}
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-9 w-9 p-0 shrink-0"
                          onClick={() => {
                            setShownEnvVars((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) {
                                next.delete(key);
                              } else {
                                next.add(key);
                              }
                              return next;
                            });
                          }}
                          aria-label={
                            shownEnvVars.has(key) ? "Hide value" : "Show value"
                          }
                          aria-pressed={shownEnvVars.has(key)}
                          title={
                            shownEnvVars.has(key) ? "Hide value" : "Show value"
                          }
                          disabled={connectionStatus === 'connected' || connectionStatus === 'connecting'}
                        >
                          {shownEnvVars.has(key) ? (
                            <Eye className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <EyeOff className="h-4 w-4" aria-hidden="true" />
                          )}
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    className="w-full mt-2"
                    onClick={() => {
                      const key = "";
                      const newEnv = { ...env };
                      newEnv[key] = "";
                      setEnv(newEnv);
                    }}
                     disabled={connectionStatus === 'connected' || connectionStatus === 'connecting'}
                  >
                    Add Environment Variable
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Button
              variant="outline"
              onClick={() => setShowConfig(!showConfig)}
              className="flex items-center w-full"
              data-testid="config-button"
              aria-expanded={showConfig}
            >
              {showConfig ? <ChevronDown className="w-4 h-4 mr-2" /> : <ChevronRight className="w-4 h-4 mr-2" />}
              <Settings className="w-4 h-4 mr-2" />
              Configuration
            </Button>
            {showConfig && (
              <div className="space-y-2">
                {Object.entries(config).map(([key, configItem]) => {
                  const configKey = key as keyof InspectorConfig;
                  return (
                    <div key={key} className="space-y-2">
                      <div className="flex items-center gap-1">
                        <label
                          className="text-sm font-medium text-green-600 break-all"
                          htmlFor={`${configKey}-input`}
                        >
                          {configItem.label}
                        </label>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            {configItem.description}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      {typeof configItem.value === "number" ? (
                        <Input
                          id={`${configKey}-input`}
                          type="number"
                          data-testid={`${configKey}-input`}
                          value={configItem.value}
                          onChange={(e) => {
                            const newConfig = { ...config };
                            newConfig[configKey] = {
                              ...configItem,
                              value: Number(e.target.value),
                            };
                            setConfig(newConfig);
                          }}
                          className="font-mono"
                        />
                      ) : typeof configItem.value === "boolean" ? (
                        <Select
                          data-testid={`${configKey}-select`}
                          value={configItem.value.toString()}
                          onValueChange={(val) => {
                            const newConfig = { ...config };
                            newConfig[configKey] = {
                              ...configItem,
                              value: val === "true",
                            };
                            setConfig(newConfig);
                          }}
                        >
                          <SelectTrigger id={`${configKey}-input`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">True</SelectItem>
                            <SelectItem value="false">False</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          id={`${configKey}-input`}
                          data-testid={`${configKey}-input`}
                          value={configItem.value}
                          onChange={(e) => {
                            const newConfig = { ...config };
                            newConfig[configKey] = {
                              ...configItem,
                              value: e.target.value,
                            };
                            setConfig(newConfig);
                          }}
                          className="font-mono"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2 pt-4 border-t border-border">
            {connectionStatus === "connected" ? (
              <Button onClick={onDisconnect} variant="destructive" className="w-full">
                <RefreshCwOff className="w-4 h-4 mr-2" />
                Disconnect
              </Button>
            ) : null}
            {connectionStatus === "connecting" && (
              <Button onClick={onDisconnect} variant="destructive" className="w-full">
                <X className="w-4 h-4 mr-2" />
                Cancel
              </Button>
            )}
            {(connectionStatus === "disconnected" || connectionStatus === "error" || connectionStatus === "error-connecting-to-proxy") && (
               <Button
                 className="w-full"
                 onClick={connect}
                 disabled={isConnectDisabled()}
               >
                 <Play className="w-4 h-4 mr-2" />
                 {getConnectButtonText()}
               </Button>
            )}

            <div className="flex items-center justify-center space-x-2 mb-4">
              <div
                className={`w-2 h-2 rounded-full ${(() => {
                  switch (connectionStatus) {
                    case "connected": return "bg-green-500";
                    case "connecting": return "bg-yellow-500";
                    case "error": return "bg-red-500";
                    case "error-connecting-to-proxy": return "bg-red-500";
                    default: return "bg-gray-500";
                  }
                })()}`}
              />
              <span className="text-sm text-gray-600">
                {(() => {
                  switch (connectionStatus) {
                    case "connected": return "Connected";
                    case "connecting": return "Connecting...";
                    case "error": return "Connection Error";
                    case "error-connecting-to-proxy": return "Proxy Error";
                    default: return "Disconnected";
                  }
                })()}
              </span>
            </div>

            {loggingSupported && connectionStatus === "connected" && (
               <div className="space-y-2">
                 <label
                   className="text-sm font-medium"
                   htmlFor="logging-level-select"
                 >
                   Logging Level
                 </label>
                 <Select
                   value={logLevel}
                   onValueChange={(value: LoggingLevel) =>
                     sendLogLevelRequest(value)
                   }
                 >
                   <SelectTrigger id="logging-level-select">
                     <SelectValue placeholder="Select logging level" />
                   </SelectTrigger>
                   <SelectContent>
                     {Object.values(LoggingLevelSchema.enum).map((level) => (
                       <SelectItem key={level} value={level}>
                         {level}
                       </SelectItem>
                     ))}
                   </SelectContent>
                 </Select>
               </div>
            )}

            {stdErrNotifications.length > 0 && (
               <>
                 <div className="mt-4 border-t border-gray-200 pt-4">
                   <div className="flex justify-between items-center">
                     <h3 className="text-sm font-medium">
                       Error output from MCP server
                     </h3>
                     <Button
                       variant="outline"
                       size="sm"
                       onClick={clearStdErrNotifications}
                       className="h-8 px-2"
                     >
                       Clear
                     </Button>
                   </div>
                   <div className="mt-2 max-h-80 overflow-y-auto">
                     {stdErrNotifications.map((notification, index) => (
                       <div
                         key={index}
                         className="text-sm text-red-500 font-mono py-2 border-b border-gray-200 last:border-b-0"
                       >
                         {notification.params.content}
                       </div>
                     ))}
                   </div>
                 </div>
               </>
            )}
          </div>
        </div>
      </div>
      <div className="p-4 border-t">
        <div className="flex items-center justify-between">
          <Select
            value={theme}
            onValueChange={(value: string) =>
              setTheme(value as "system" | "light" | "dark")
            }
          >
            <SelectTrigger className="w-[100px]" id="theme-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center space-x-2">
            <Button variant="ghost" title="Inspector Documentation" asChild>
              <a
                href="https://modelcontextprotocol.io/docs/tools/inspector"
                target="_blank"
                rel="noopener noreferrer"
              >
                <CircleHelp className="w-4 h-4 text-foreground" />
              </a>
            </Button>
            <Button variant="ghost" title="Debugging Guide" asChild>
              <a
                href="https://modelcontextprotocol.io/docs/tools/debugging"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Bug className="w-4 h-4 text-foreground" />
              </a>
            </Button>
            <Button
              variant="ghost"
              title="Report bugs or contribute on GitHub"
              asChild
            >
              <a
                href="https://github.com/modelcontextprotocol/inspector"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="w-4 h-4 text-foreground" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
