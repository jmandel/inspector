import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * IntraBrowserTransport connects to an MCP server running in a different browser context (tab/iframe)
 * using window.postMessage() for communication.
 * 
 * Security Note: This transport validates both the origin and source (window reference) of messages.
 */
export class IntraBrowserClientTransport implements Transport {
  private targetWindow: Window;
  private targetOrigin: string;
  private isConnected: boolean = false;
  private iframePendingReady: boolean = true;
  private messageQueue: JSONRPCMessage[] = [];
  public sessionId: string = self.crypto.randomUUID();

  // Event handlers
  public onmessage?: ((message: JSONRPCMessage) => void);
  public onclose?: (() => void);
  public onerror?: ((error: Error) => void);
  public onconnect?: (() => void);
  
  constructor(targetWindow: Window, targetOrigin: string) {
    console.log("[IntraBrowserClientTransport] Constructor called with targetWindow:", targetWindow, "and targetOrigin:", targetOrigin);
    this.targetWindow = targetWindow;
    this.targetOrigin = targetOrigin;
    
    // Set up message listener
    window.addEventListener('message', this.handleMessage);
    
    // Check periodically if the window is closed
    this.checkTargetWindow();
  }

  public async start(): Promise<void> {
    console.log("[IntraBrowserClientTransport] Starting transport and waiting for server_ready...");
    
    return new Promise<void>((resolve, reject) => {
      // Create a timeout for 10 seconds
      const timeout = setTimeout(() => {
        console.warn("[IntraBrowserClientTransport] Timeout waiting for iframe to send server_ready notification");
        reject(new Error("Timeout waiting for iframe to send server_ready notification"));
      }, 10000);

      // One-time listener for server_ready message
      const readyListener = (event: MessageEvent) => {
        // Security check - only accept messages from the expected origin and source
        if ((this.targetOrigin !== '*' && event.origin !== this.targetOrigin) || 
            event.source !== this.targetWindow) {
          console.warn("[IntraBrowserClientTransport] Ignoring message from unexpected origin or source");
          return;
        }

        console.log("[IntraBrowserClientTransport] Received server_ready notification");
        try {
          const message = typeof event.data === 'string' 
            ? JSON.parse(event.data) 
            : event.data;
          
          if (message.method === 'server_ready') {
            // Server is ready to receive messages
            console.log("[IntraBrowserTransport] Received server_ready notification");
            this.iframePendingReady = false;
            this.isConnected = true;
            
            // Flush queued messages
            this.flushQueue();
            
            // Notify onconnect handler if registered
            if (this.onconnect) {
              this.onconnect();
            }
            
            // Remove this listener and the timeout
            window.removeEventListener('message', readyListener);
            clearTimeout(timeout);
            resolve();
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      };
      
      // Add the temporary listener
      window.addEventListener('message', readyListener);
      
      // After listener is active, proactively ping the iframe so it can respond with server_ready if we missed the first one
      try {
        console.log("[IntraBrowserClientTransport] Sending ping_check to iframe", this.targetOrigin);
        this.targetWindow.postMessage(
          JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
          this.targetOrigin,
        );
      } catch (err) {
        console.warn("[IntraBrowserClientTransport] Failed to send ping_check:", err);
      }
    });
  }
  

  // Check if the message is a request (has method and id)
  private isRequest(message: any): message is { jsonrpc: "2.0"; method: string; id: string | number; params?: any } {
    return message && 
           message.jsonrpc === "2.0" && 
           typeof message.method === 'string' && 
           (typeof message.id === 'string' || typeof message.id === 'number');
  }


  // Listen for messages from the window
  private handleMessage = (event: MessageEvent) => {
    // Validate message origin
    if (this.targetOrigin !== '*' && event.origin !== this.targetOrigin) {
      console.warn(`[IntraBrowserClientTransport] Ignoring message from unauthorized origin: ${event.origin}`);
      return;
    }

    // Validate message source (only accept messages from our target window)
    if (event.source !== this.targetWindow) {
      console.warn(`[IntraBrowserClientTransport] Ignoring message from unauthorized source`);
      return;
    }

    try {
      // Parse the message data
      const message = typeof event.data === 'string' 
        ? JSON.parse(event.data) 
        : event.data;

      // Log all received messages
      console.log(`[IntraBrowserClientTransport] RECEIVED: ${JSON.stringify(message)}`);

      // Prevent transport-internal server_ready message from bubbling up
      if (message?.method === 'server_ready') {
        console.log("[IntraBrowserClientTransport] Intercepted server_ready message, not forwarding.");
        return;
      }

      // Only process if we have an onmessage handler
      if (this.onmessage) {
        this.onmessage(message as JSONRPCMessage);
      }
    } catch (error) {
      console.error('[IntraBrowserClientTransport] Error processing message:', error);
      if (this.onerror) {
        this.onerror(new Error(`Error processing message: ${error}`));
      }
    }
  };
  
  private checkTargetWindow = () => {
    // Check if window is closed periodically
    const checkInterval = setInterval(() => {
      try {
        // This will throw if window is closed
        if (this.targetWindow.closed) {
          clearInterval(checkInterval);
          this.close();
        }
      } catch (err) {
        clearInterval(checkInterval);
        this.close();
      }
    }, 1000);
  };
  
  public async send(message: JSONRPCMessage): Promise<void> {
    // Extra detailed logging for initialize method
    if (this.isRequest(message) && message.method === 'initialize') {
      console.log(`[IntraBrowserClientTransport] 🔍 INITIALIZE REQUEST DETECTED 🔍`);
      console.log(`[IntraBrowserClientTransport] Connection state: connected=${this.isConnected}, pendingReady=${this.iframePendingReady}`);
      console.log(`[IntraBrowserClientTransport] Target window exists: ${!!this.targetWindow}, closed=${this.targetWindow?.closed}`);
    }
    
    if (!this.isConnected) {
      if (this.iframePendingReady) {
        // Queue message until iframe is ready
        console.log(`[IntraBrowserClientTransport] Queueing message (server not ready): ${JSON.stringify(message)}`);
        if (this.isRequest(message) && message.method === 'initialize') {
          console.log(`[IntraBrowserClientTransport] ⚠️ IMPORTANT: initialize method is being queued! It will be sent after server_ready.`);
        }
        this.messageQueue.push(message);
        return;
      }
      const errorMsg = "Transport not connected";
      console.error(`[IntraBrowserClientTransport] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    try {
      const messageStr = JSON.stringify(message);
      console.log(`[IntraBrowserClientTransport] SENDING: ${messageStr}`);
      
      if (this.isRequest(message) && message.method === 'initialize') {
        console.log(`[IntraBrowserClientTransport] 🚀 SENDING INITIALIZE to ${this.targetOrigin}`);
      }
      
      this.targetWindow.postMessage(messageStr, this.targetOrigin);
      
      if (this.isRequest(message) && message.method === 'initialize') {
        console.log(`[IntraBrowserClientTransport] ✅ INITIALIZE POSTED successfully`);
      }
    } catch (err) {
      const errorMsg = `Failed to send message: ${err}`;
      console.error(`[IntraBrowserClientTransport] ${errorMsg}`);
      const error = new Error(errorMsg);
      if (this.onerror) {
        this.onerror(error);
      }
      this.close();
      throw error;
    }
  }
  
  public async close(): Promise<void> {
    if (!this.isConnected) return;
    
    window.removeEventListener('message', this.handleMessage);
    this.isConnected = false;
    
    if (this.onclose) {
      this.onclose();
    }
  }

  private flushQueue = () => {
    if (this.messageQueue.length > 0) {
      console.log(`[IntraBrowserClientTransport] Flushing ${this.messageQueue.length} queued messages`);
    }
    
    while (this.messageQueue.length > 0) {
      const queuedMessage = this.messageQueue.shift();
      if (queuedMessage) {
        const messageStr = JSON.stringify(queuedMessage);
        console.log(`[IntraBrowserClientTransport] SENDING from queue: ${messageStr}`);
        
        if (this.isRequest(queuedMessage) && queuedMessage.method === 'initialize') {
          console.log(`[IntraBrowserClientTransport] 🚀 SENDING QUEUED INITIALIZE to ${this.targetOrigin}`);
        }
        
        this.targetWindow.postMessage(messageStr, this.targetOrigin);
        
        if (this.isRequest(queuedMessage) && queuedMessage.method === 'initialize') {
          console.log(`[IntraBrowserClientTransport] ✅ QUEUED INITIALIZE POSTED successfully`);
        }
      }
    }
  }
}

/**
 * Transport for a server running in the browser.
 * This is meant to be used in the iframe/window that hosts the MCP server,
 * to talk to the MCP Inspector client running in the parent window.
 */
export class IntraBrowserServerTransport implements Transport {
  private expectedClientOrigin: string;
  private clientWindow: Window | null = null;
  private clientOrigin: string | null = null;
  private isConnected: boolean = false;
  public sessionId: string = self.crypto.randomUUID();
  private readyTicker?: number;   // id from setInterval
  
  // Event handlers
  public onmessage?: ((message: JSONRPCMessage) => void);
  public onclose?: (() => void);
  public onerror?: ((error: Error) => void);
  
  // Check if the message is a request (has method and id)
  private isRequest(message: any): message is { jsonrpc: "2.0"; method: string; id: string | number; params?: any } {
    return message && 
           message.jsonrpc === "2.0" && 
           typeof message.method === 'string' && 
           (typeof message.id === 'string' || typeof message.id === 'number');
  }

  // Check if the message is a response (has id but no method)
  private isResponse(message: any): message is { jsonrpc: "2.0"; id: string | number; result?: any; error?: any } {
    return message && 
           message.jsonrpc === "2.0" && 
           (typeof message.id === 'string' || typeof message.id === 'number') && 
           message.method === undefined;
  }
  
  constructor(expectedClientOrigin: string) {
    this.expectedClientOrigin = expectedClientOrigin;
    // Set up message listener immediately – we may receive messages before start()
    window.addEventListener('message', this.handleMessage);
  }
  
  public async start(): Promise<void> {
    // one immediate send
    this.announceReady();

    // keep sending every 500 ms until we see any legitimate request
    this.readyTicker = window.setInterval(() => this.announceReady(), 500);
    return Promise.resolve();
  }
  
  private handleMessage = (event: MessageEvent) => {
    // Origin safety check (allow expected origin or match against stored origin)
    if (this.expectedClientOrigin && event.origin !== this.expectedClientOrigin && this.expectedClientOrigin !== '*') {
      console.warn(`[IntraBrowserServerTransport] Ignoring message from unexpected origin: ${event.origin} (expected ${this.expectedClientOrigin})`);
      return;
    }
    
    try {
      // Store client reference on first message if not already set
      if (!this.clientWindow) {
        this.clientWindow = event.source as Window;
        this.clientOrigin = event.origin;
        this.isConnected = true;
        console.log(`[IntraBrowserServerTransport] Established connection with client at origin: ${event.origin}`);
        // Re-announce readiness now that we know the exact client window & origin
        this.announceReady();
      } else if (event.source !== this.clientWindow) {
        // Ignore messages from unexpected sources
        console.warn(`[IntraBrowserServerTransport] Ignoring message from unexpected source`);
        return;
      }
      
      // Parse message
      const jsonData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      
      // Log the received message
      console.log(`[IntraBrowserServerTransport] RECEIVED: ${JSON.stringify(jsonData)}`);
      
      // Extra logging for initialize method
      if (this.isRequest(jsonData) && jsonData.method === 'initialize') {
        console.log(`[IntraBrowserServerTransport] 🔍 INITIALIZE REQUEST RECEIVED 🔍`);
        console.log(`[IntraBrowserServerTransport] onmessage handler exists: ${!!this.onmessage}`);
      }
      
      if (this.onmessage) {
        if (this.isRequest(jsonData) && jsonData.method === 'initialize') {
          console.log(`[IntraBrowserServerTransport] ➡️ Forwarding initialize to onmessage handler`);
        }
        this.onmessage(jsonData);
      }

      // First real message => stop the ticker
      if (this.readyTicker) {
        clearInterval(this.readyTicker);
        this.readyTicker = undefined;
      }
    } catch (err) {
      console.error(`[IntraBrowserServerTransport] Error processing message: ${err}`);
      if (this.onerror) {
        this.onerror(new Error(`Error processing message: ${err}`));
      }
    }
  };
  
  public async send(message: JSONRPCMessage): Promise<void> {
    // Extra logging for initialize response
    if (this.isResponse(message) && message.id && 
        typeof message.id === 'string' && message.id.includes('initialize')) {
      console.log(`[IntraBrowserServerTransport] 🔍 INITIALIZE RESPONSE DETECTED 🔍`);
      console.log(`[IntraBrowserServerTransport] Client connection state: clientWindow=${!!this.clientWindow}, clientOrigin=${this.clientOrigin}`);
    }
    
    if (!this.clientWindow || !this.clientOrigin) {
      const errorMsg = 'Cannot send message: No client connection established';
      console.error(`[IntraBrowserServerTransport] ${errorMsg}`);
      const error = new Error(errorMsg);
      if (this.onerror) {
        this.onerror(error);
      }
      throw error;
    }
    
    try {
      const messageStr = JSON.stringify(message);
      // Log the outgoing message
      console.log(`[IntraBrowserServerTransport] SENDING: ${messageStr}`);
      
      if (this.isResponse(message) && message.id && 
          typeof message.id === 'string' && message.id.includes('initialize')) {
        console.log(`[IntraBrowserServerTransport] 🚀 SENDING INITIALIZE RESPONSE to ${this.clientOrigin}`);
      }
      
      this.clientWindow.postMessage(messageStr, this.clientOrigin);
      
      if (this.isResponse(message) && message.id && 
          typeof message.id === 'string' && message.id.includes('initialize')) {
        console.log(`[IntraBrowserServerTransport] ✅ INITIALIZE RESPONSE POSTED successfully`);
      }
    } catch (err) {
      const errorMsg = `Failed to send message: ${err}`;
      console.error(`[IntraBrowserServerTransport] ${errorMsg}`);
      const error = new Error(errorMsg);
      if (this.onerror) {
        this.onerror(error);
      }
      this.close();
      throw error;
    }
  }
  
  public async close(): Promise<void> {
    if (this.readyTicker) {
      clearInterval(this.readyTicker);
      this.readyTicker = undefined;
    }
    if (!this.isConnected) return;
    
    window.removeEventListener('message', this.handleMessage);
    this.clientWindow = null;
    this.clientOrigin = null;
    this.isConnected = false;
    
    if (this.onclose) {
      this.onclose();
    }
  }

  private announceReady = () => {
    // Send server_ready message to parent window
    try {
      const readyMsg = JSON.stringify({ jsonrpc: "2.0", method: "server_ready" });
      console.log(`[IntraBrowserServerTransport] SENDING ready notification: ${readyMsg}`, this.expectedClientOrigin);
      window.parent.postMessage(readyMsg, this.expectedClientOrigin || '*');
      console.log(`[IntraBrowserServerTransport] Sent 'server_ready' notification to parent using origin: ${this.expectedClientOrigin || '*'}`);
    } catch (e) {
      console.error(`[IntraBrowserServerTransport] Error sending server_ready notification: ${e}`);
    }
  };
} 