// Global MCP Inspector API 
interface Window {
  MCP_INSPECTOR_API?: {
    connectIntraBrowserTransport?: () => void;
  }
} 