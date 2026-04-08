interface ContextEntry {
  id: string;
  content: string;
  hash: string;
  lastAccessed: number;
  accessCount: number;
  size: number;
  metadata: Record<string, any>;
}

interface RecyclingStats {
  totalContexts: number;
  uniqueContexts: number;
  memoryUsage: number;
  deduplicationRate: number;
  recycledCount: number;
  estimatedSavings: number;
  lastGarbageCollection: number;
}

class ContextRecycler {
  private contexts: Map<string, ContextEntry> = new Map();
  private hashIndex: Map<string, Set<string>> = new Map();
  private memoryPressureThreshold: number = 0.8;
  private maxMemoryBytes: number = 50 * 1024 * 1024;
  private stats: RecyclingStats = {
    totalContexts: 0,
    uniqueContexts: 0,
    memoryUsage: 0,
    deduplicationRate: 0,
    recycledCount: 0,
    estimatedSavings: 0,
    lastGarbageCollection: Date.now()
  };

  private generateHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  private async manageMemoryPressure(): Promise<void> {
    const currentMemory = this.stats.memoryUsage / this.maxMemoryBytes;
    
    if (currentMemory > this.memoryPressureThreshold) {
      await this.performGarbageCollection();
    }
  }

  private async performGarbageCollection(): Promise<void> {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;
    const entries = Array.from(this.contexts.entries());
    
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    let freedMemory = 0;
    for (const [id, entry] of entries) {
      if (now - entry.lastAccessed > maxAge || 
          freedMemory < this.maxMemoryBytes * 0.3) {
        
        this.contexts.delete(id);
        const hashSet = this.hashIndex.get(entry.hash);
        if (hashSet) {
          hashSet.delete(id);
          if (hashSet.size === 0) {
            this.hashIndex.delete(entry.hash);
          }
        }
        freedMemory += entry.size;
      } else {
        break;
      }
    }
    
    this.stats.lastGarbageCollection = now;
    this.updateStats();
  }

  private updateStats(): void {
    const total = this.stats.totalContexts;
    const unique = this.contexts.size;
    
    this.stats.uniqueContexts = unique;
    this.stats.deduplicationRate = total > 0 ? 
      ((total - unique) / total) * 100 : 0;
    
    this.stats.memoryUsage = Array.from(this.contexts.values())
      .reduce((sum, entry) => sum + entry.size, 0);
    
    this.stats.estimatedSavings = this.stats.recycledCount * 1024;
  }

  async recycleContext(context: any): Promise<{id: string; recycled: boolean}> {
    await this.manageMemoryPressure();
    
    const content = JSON.stringify(context);
    const hash = this.generateHash(content);
    const size = new Blob([content]).size;
    
    const existingIds = this.hashIndex.get(hash);
    if (existingIds && existingIds.size > 0) {
      const existingId = Array.from(existingIds)[0];
      const entry = this.contexts.get(existingId);
      
      if (entry) {
        entry.lastAccessed = Date.now();
        entry.accessCount++;
        this.stats.recycledCount++;
        this.stats.totalContexts++;
        this.updateStats();
        
        return {id: existingId, recycled: true};
      }
    }
    
    const id = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newEntry: ContextEntry = {
      id,
      content,
      hash,
      lastAccessed: Date.now(),
      accessCount: 1,
      size,
      metadata: {
        created: Date.now(),
        source: "recycler"
      }
    };
    
    this.contexts.set(id, newEntry);
    
    if (!this.hashIndex.has(hash)) {
      this.hashIndex.set(hash, new Set());
    }
    this.hashIndex.get(hash)!.add(id);
    
    this.stats.totalContexts++;
    this.updateStats();
    
    return {id, recycled: false};
  }

  getStats(): RecyclingStats {
    return {...this.stats};
  }

  getSavings(): {recycled: number; estimatedBytes: number; efficiency: number} {
    return {
      recycled: this.stats.recycledCount,
      estimatedBytes: this.stats.estimatedSavings,
      efficiency: this.stats.deduplicationRate
    };
  }

  getContext(id: string): ContextEntry | null {
    const entry = this.contexts.get(id);
    if (entry) {
      entry.lastAccessed = Date.now();
      entry.accessCount++;
      return {...entry};
    }
    return null;
  }
}

const recycler = new ContextRecycler();

const handleRequest = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {headers: corsHeaders});
  }

  const securityHeaders = {
    "Content-Security-Policy": "default-src 'self'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders
  };

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({status: "healthy", timestamp: Date.now()}), {
      headers: {"Content-Type": "application/json", ...securityHeaders}
    });
  }

  if (url.pathname === "/api/recycle" && request.method === "POST") {
    try {
      const context = await request.json();
      const result = await recycler.recycleContext(context);
      
      return new Response(JSON.stringify(result), {
        headers: {"Content-Type": "application/json", ...securityHeaders}
      });
    } catch (error) {
      return new Response(JSON.stringify({error: "Invalid context"}), {
        status: 400,
        headers: {"Content-Type": "application/json", ...securityHeaders}
      });
    }
  }

  if (url.pathname === "/api/stats" && request.method === "GET") {
    const stats = recycler.getStats();
    
    return new Response(JSON.stringify(stats), {
      headers: {"Content-Type": "application/json", ...securityHeaders}
    });
  }

  if (url.pathname === "/api/savings" && request.method === "GET") {
    const savings = recycler.getSavings();
    
    return new Response(JSON.stringify(savings), {
      headers: {"Content-Type": "application/json", ...securityHeaders}
    });
  }

  const footer = `
    <footer style="
      position: fixed;
      bottom: 0;
      width: 100%;
      background: #0a0a0f;
      color: #10b981;
      text-align: center;
      padding: 1rem;
      font-family: 'Inter', sans-serif;
      border-top: 1px solid #10b981;
    ">
      Context Recycler • Fleet Operations • ${new Date().getFullYear()}
    </footer>
  `;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Context Recycler</title>
        <style>
          body {
            margin: 0;
            padding: 0;
            background: #0a0a0f;
            color: #ffffff;
            font-family: 'Inter', sans-serif;
            min-height: 100vh;
          }
          .hero {
            text-align: center;
            padding: 4rem 2rem;
            background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
          }
          .hero h1 {
            color: #10b981;
            font-size: 3rem;
            margin-bottom: 1rem;
          }
          .endpoints {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
            padding: 2rem;
            max-width: 1200px;
            margin: 0 auto;
          }
          .endpoint-card {
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid #10b981;
            border-radius: 8px;
            padding: 1.5rem;
          }
          code {
            background: rgba(255,255,255,0.1);
            padding: 0.2rem 0.4rem;
            border-radius: 4px;
            font-family: monospace;
          }
        </style>
      </head>
      <body>
        <div class="hero">
          <h1>Context Recycler</h1>
          <p>Reclaim and repurpose context across fleet operations</p>
        </div>
        <div class="endpoints">
          <div class="endpoint-card">
            <h3>POST /api/recycle</h3>
            <p>Submit context for deduplication and recycling</p>
          </div>
          <div class="endpoint-card">
            <h3>GET /api/stats</h3>
            <p>Get recycling efficiency metrics</p>
          </div>
          <div class="endpoint-card">
            <h3>GET /api/savings</h3>
            <p>View estimated resource savings</p>
          </div>
        </div>
        ${footer}
      </body>
    </html>
  `;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      ...securityHeaders
    }
  });
};

export default {
  async fetch(request: Request): Promise<Response> {
    return handleRequest(request);
  }
};