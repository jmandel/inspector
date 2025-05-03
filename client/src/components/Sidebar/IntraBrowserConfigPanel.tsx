import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { useLocalStorage } from "../../hooks/use-local-storage";
import { useEffect, useState } from "react";

interface IntraBrowserConfigPanelProps {
  onConnect: (targetUrl: string, targetOrigin: string) => void;
  onDisconnect: () => void;
  isConnected: boolean;
  isConnecting: boolean;
}

export function IntraBrowserConfigPanel({
  onConnect,
  onDisconnect,
  isConnected,
  isConnecting,
}: IntraBrowserConfigPanelProps) {
  const [targetUrl, setTargetUrl] = useLocalStorage(
    "mcp-inspector-target-url",
    "http://localhost:8787/ehr-mcp/index.html"
  );
  
  // We'll derive origin from the URL by default
  const [inferredOrigin, setInferredOrigin] = useState<string>("");
  
  // When target URL changes, infer the origin
  useEffect(() => {
    try {
      if (targetUrl) {
        const url = new URL(targetUrl);
        setInferredOrigin(url.origin);
      }
    } catch (e) {
      console.warn("Couldn't parse URL to infer origin:", e);
    }
  }, [targetUrl]);
  
  // Custom origin is optional - falls back to inferred origin
  const [customOrigin, setCustomOrigin] = useLocalStorage<string | null>(
    "mcp-inspector-target-origin-override",
    null
  );
  
  // Use custom origin if set, otherwise use inferred origin
  const effectiveOrigin = customOrigin || inferredOrigin;
  
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleConnect = () => {
    onConnect(targetUrl, effectiveOrigin);
  };

  // Expose the connect function for external access when the global Connect button is pressed
  useEffect(() => {
    if (window.MCP_INSPECTOR_API === undefined) {
      window.MCP_INSPECTOR_API = {};
    }
    
    // Register the connect handler for this transport
    window.MCP_INSPECTOR_API.connectIntraBrowserTransport = handleConnect;
    
    return () => {
      // Clean up when component unmounts
      if (window.MCP_INSPECTOR_API) {
        delete window.MCP_INSPECTOR_API.connectIntraBrowserTransport;
      }
    };
  }, [targetUrl, effectiveOrigin, onConnect]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>IntraBrowserTransport Configuration</CardTitle>
        <CardDescription>
          Connect to an MCP server running in a different browser context
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="target-url">Target URL</Label>
          <Input
            id="target-url"
            placeholder="https://example.com/mcp-embedded"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            disabled={isConnected || isConnecting}
          />
          <p className="text-sm text-muted-foreground">
            URL of the page containing the MCP server
          </p>
        </div>
        
        <div className="flex items-center">
          <Button 
            variant="link" 
            className="p-0 h-auto text-xs" 
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? "Hide Advanced Options" : "Show Advanced Options"}
          </Button>
        </div>
        
        {showAdvanced && (
          <div className="space-y-2 pt-2 border-t">
            <Label htmlFor="target-origin">Custom Origin</Label>
            <Input
              id="target-origin"
              placeholder={inferredOrigin || "https://example.com"}
              value={customOrigin || ""}
              onChange={(e) => setCustomOrigin(e.target.value || null)}
              disabled={isConnected || isConnecting}
            />
            <p className="text-sm text-muted-foreground">
              The origin of the target context (automatically inferred if blank)
            </p>
            <div className="text-sm bg-muted/50 p-2 rounded-md">
              <span className="font-medium">Using origin:</span> {effectiveOrigin}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 