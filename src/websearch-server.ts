import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "websearch", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_web",
        description: "Search the web for information using a lightweight search engine. Returns text summaries and URLs.",
        inputSchema: {
          type: "object",
          properties: {
            query: { 
              type: "string",
              description: "The search query"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "fetch_url",
        description: "Fetch the raw text content of a webpage given its URL.",
        inputSchema: {
          type: "object",
          properties: {
            url: { 
              type: "string",
              description: "The full URL to fetch (e.g. https://example.com)"
            }
          },
          required: ["url"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  if (request.params.name === "search_web") {
    const query = request.params.arguments?.query;
    if (!query) {
      return { isError: true, content: [{ type: "text", text: "Query is required" }] };
    }
    
    try {
      // Using DuckDuckGo Lite which is heavily text-based and easy to strip
      const response = await fetch("https://lite.duckduckgo.com/lite/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36)"
        },
        body: `q=${encodeURIComponent(query)}`
      });
      
      const html = await response.text();
      
      // Basic HTML stripping
      let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                     .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                     .replace(/<[^>]*>?/gm, ' ')
                     .replace(/&nbsp;/g, ' ')
                     .replace(/&amp;/g, '&')
                     .replace(/&quot;/g, '"')
                     .replace(/&#39;/g, "'")
                     .replace(/\s{2,}/g, ' ')
                     .trim();
      
      // Truncate to save tokens (we just want the search results, usually in the first few KB of text)
      if (text.length > 5000) {
        text = text.substring(0, 5000) + "...";
      }
      
      return {
        content: [{ type: "text", text: `Search Results for "${query}":\n\n${text}` }]
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Search failed: ${e.message}` }]
      };
    }
  }
  
  if (request.params.name === "fetch_url") {
    const url = request.params.arguments?.url;
    if (!url) {
      return { isError: true, content: [{ type: "text", text: "URL is required" }] };
    }
    
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      
      const html = await response.text();
      
      // Basic HTML stripping
      let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                     .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                     .replace(/<[^>]*>?/gm, ' ')
                     .replace(/\s{2,}/g, ' ')
                     .trim();
                     
      if (text.length > 8000) {
        text = text.substring(0, 8000) + "...";
      }
      
      return {
        content: [{ type: "text", text }]
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Fetch failed: ${e.message}` }]
      };
    }
  }
  
  throw new Error("Tool not found");
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch(console.error);
