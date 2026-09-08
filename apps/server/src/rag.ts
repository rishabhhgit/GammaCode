import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

export interface DocumentChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
}

/** Simple chunking and keyword/TF-IDF retrieval for basic RAG without external heavy vector DB dependencies */
export class BasicRagEngine {
  private chunks: DocumentChunk[] = [];
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async indexWorkspace(maxFiles = 100): Promise<number> {
    this.chunks = [];
    const files = await this.collectFiles(this.workspaceRoot);
    
    let indexedFiles = 0;
    for (const filePath of files.slice(0, maxFiles)) {
      try {
        const absPath = path.resolve(this.workspaceRoot, filePath);
        const stats = await stat(absPath);
        if (stats.size > 200_000) continue; // skip huge files

        const content = await readFile(absPath, "utf8");
        const fileChunks = this.chunkText(filePath, content);
        this.chunks.push(...fileChunks);
        indexedFiles++;
      } catch (err) {
        logger.warn("rag.index_file_failed", { filePath, error: err instanceof Error ? err.message : String(err) });
      }
    }

    logger.info("rag.indexed", { files: indexedFiles, chunks: this.chunks.length });
    return this.chunks.length;
  }

  private async collectFiles(dir: string, baseDir = dir): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    let results: string[] = [];
    
    const ignored = new Set([".git", "node_modules", "dist", ".turbo", ".vite", "coverage"]);

    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this.collectFiles(fullPath, baseDir);
        results.push(...sub);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const allowedExts = new Set([".ts", ".tsx", ".js", ".jsx", ".md", ".json", ".txt", ".py", ".rs", ".go", ".html", ".css"]);
        if (allowedExts.has(ext) || entry.name === "Dockerfile" || entry.name === "Makefile") {
          results.push(path.relative(baseDir, fullPath));
        }
      }
    }
    return results;
  }

  private chunkText(filePath: string, text: string, chunkSize = 40, overlap = 10): DocumentChunk[] {
    const lines = text.split("\n");
    const chunks: DocumentChunk[] = [];
    
    if (lines.length <= chunkSize) {
      return [{
        id: `${filePath}:1-${lines.length}`,
        filePath,
        content: text,
        startLine: 1,
        endLine: lines.length
      }];
    }

    for (let i = 0; i < lines.length; i += (chunkSize - overlap)) {
      const end = Math.min(i + chunkSize, lines.length);
      const chunkLines = lines.slice(i, end);
      const content = chunkLines.join("\n");
      if (content.trim().length > 0) {
        chunks.push({
          id: `${filePath}:${i + 1}-${end}`,
          filePath,
          content,
          startLine: i + 1,
          endLine: end
        });
      }
      if (end === lines.length) break;
    }

    return chunks;
  }

  /** Retrieve top relevant chunks for a given query using keyword matching / TF-IDF scoring */
  search(query: string, topK = 4): DocumentChunk[] {
    if (this.chunks.length === 0) return [];

    const queryTerms = query
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (queryTerms.length === 0) return this.chunks.slice(0, topK);

    const scored = this.chunks.map((chunk) => {
      const lowerContent = chunk.content.toLowerCase();
      const lowerPath = chunk.filePath.toLowerCase();
      let score = 0;

      for (const term of queryTerms) {
        // Exact term match in path gets high bonus
        if (lowerPath.includes(term)) score += 5;

        // Count term occurrences in chunk content
        let pos = lowerContent.indexOf(term);
        while (pos !== -1) {
          score += 1;
          pos = lowerContent.indexOf(term, pos + 1);
        }
      }

      return { chunk, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Return top K chunks that have score > 0, or topK defaults if none matched
    const results = scored.filter((s) => s.score > 0).slice(0, topK).map((s) => s.chunk);
    if (results.length === 0) {
      return this.chunks.slice(0, topK);
    }
    return results;
  }
}
