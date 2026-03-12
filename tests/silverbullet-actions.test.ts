import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncSystem, validateLua, runQuery } from '../src/silverbullet-actions.js';
import { getSharedContext, pagePathToUrl } from '../src/silverbullet-browser.js';

vi.mock('../src/silverbullet-browser.js', () => ({
  getSharedContext: vi.fn(),
  pagePathToUrl: vi.fn((path: string) => `http://localhost/${path}`),
  filenameToPagePath: vi.fn((f: string) => f),
  invalidateSharedContext: vi.fn(),
}));

describe('SilverBullet Actions', () => {
  let mockPage: any;

  beforeEach(() => {
    vi.clearAllMocks();
    let currentUrl = 'about:blank';
    mockPage = {
      goto: vi.fn().mockImplementation(async (url: string) => {
        currentUrl = url;
        return {};
      }),
      evaluate: vi.fn().mockImplementation(async (fn: any, ...args: any[]) => {
        const fnStr = fn.toString();
        
        // If it's the client check in ensureClientReady
        if (fnStr.includes('window.client') && !fnStr.includes('runCommandByName') && !fnStr.includes('lua.parse') && !fnStr.includes('lua.evalExpression')) {
          return {
            hasClient: true,
            systemReady: true,
            hasClientSystem: true,
            hasSystem: true,
            hasLocalSyscall: true,
            registeredSyscalls: ["index.getObjectByRef"],
            url: currentUrl,
          };
        }
        
        // Default url return for includes check
        return { url: currentUrl };
      }),
      close: vi.fn().mockResolvedValue({}),
      url: vi.fn(() => currentUrl),
      isClosed: vi.fn(() => false),
    };
    (getSharedContext as any).mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(mockPage),
    });
  });

  describe('syncSystem', () => {
    it('should trigger reindex and reload', async () => {
      // Setup evaluate to handle the inner sync logic after ensureClientReady passes
      mockPage.evaluate.mockImplementation(async (fn: any, ...args: any[]) => {
        const fnStr = fn.toString();
        const url = 'http://localhost/index';
        
        if (fnStr.includes('window.client') && !fnStr.includes('runCommandByName')) {
          return { hasClient: true, systemReady: true, hasLocalSyscall: true, registeredSyscalls: ["index.getObjectByRef"], url };
        }
        
        if (fnStr.includes('runCommandByName')) {
           return { message: "success" };
        }
        
        return { url };
      });

      const result = await syncSystem(false);
      expect(mockPage.goto).toHaveBeenCalledWith(expect.stringContaining('index'), expect.anything());
      expect(mockPage.evaluate).toHaveBeenCalled();
      expect(result.message).toContain('successfully');
    });
  });

  describe('validateLua', () => {
    it('should return valid true for correct code', async () => {
      mockPage.evaluate.mockImplementation(async (fn: any, ...args: any[]) => {
        const fnStr = fn.toString();
        const url = 'http://localhost/index';
        if (fnStr.includes('window.client') && !fnStr.includes('lua.parse')) {
          return { hasClient: true, systemReady: true, hasLocalSyscall: true, registeredSyscalls: ["index.getObjectByRef"], url };
        }
        if (fnStr.includes('lua.parse')) {
          return { valid: true };
        }
        return { url };
      });
      const result = await validateLua('return true');
      expect(result.valid).toBe(true);
    });

    it('should return error for invalid code', async () => {
      mockPage.evaluate.mockImplementation(async (fn: any, ...args: any[]) => {
        const fnStr = fn.toString();
        const url = 'http://localhost/index';
        if (fnStr.includes('window.client') && !fnStr.includes('lua.parse')) {
          return { hasClient: true, systemReady: true, hasLocalSyscall: true, registeredSyscalls: ["index.getObjectByRef"], url };
        }
        if (fnStr.includes('lua.parse')) {
          return { 
            valid: false, 
            error: 'Parse error at line 1, column 5: ...',
            line: 1,
            column: 5
          };
        }
        return { url };
      });
      const result = await validateLua('for i=1 10 do');
      expect(result.valid).toBe(false);
      expect(result.line).toBe(1);
    });
  });

  describe('runQuery', () => {
    it('should return query results', async () => {
      const mockResults = [{ name: 'test' }];
      mockPage.evaluate.mockImplementation(async (fn: any, ...args: any[]) => {
        const fnStr = fn.toString();
        const url = 'http://localhost/index';
        if (fnStr.includes('window.client') && !fnStr.includes('lua.evalExpression')) {
          return { hasClient: true, systemReady: true, hasLocalSyscall: true, registeredSyscalls: ["index.getObjectByRef"], url };
        }
        if (fnStr.includes('lua.evalExpression')) {
          return mockResults;
        }
        return { url };
      });
      const result = await runQuery('from index.tag "page"');
      expect(result.results).toEqual(mockResults);
    });
  });
});
