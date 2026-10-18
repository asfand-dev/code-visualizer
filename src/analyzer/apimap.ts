import { externalHost, localPath, routeScore, segments } from '../shared/route-match.js';
import type { ApiCall, RouteInfo, SymbolInfo } from '../shared/types.js';
import type { RawApiCall } from './parse.js';

function enclosingSymbol(symbols: SymbolInfo[], line: number): SymbolInfo | undefined {
  let best: SymbolInfo | undefined;
  for (const s of symbols) {
    if (line < s.line || line > s.endLine) continue;
    if (!best || s.endLine - s.line < best.endLine - best.line) best = s;
  }
  return best;
}

/** Link HTTP calls in the code to the routes that serve them (exact match first, then suffix match for base URLs). */
export function linkApiCalls(calls: { file: string; symbols: SymbolInfo[]; raw: RawApiCall[] }[], routes: RouteInfo[]): ApiCall[] {
  const endpoints = routes.filter((r) => r.type === 'api' || r.type === 'page').map((r) => ({ route: r, segs: segments(r.path) }));
  const result: ApiCall[] = [];
  for (const { file, symbols, raw } of calls) {
    raw.forEach((call, i) => {
      const external = externalHost(call.url);
      let route: RouteInfo | undefined;
      if (!external) {
        const segs = segments(localPath(call.url) ?? call.url);
        const pages = call.client === 'supertest';
        let best = 0;
        for (const ep of endpoints) {
          const s = routeScore(ep.route, ep.segs, call.method, segs, { pages });
          if (s > best) {
            best = s;
            route = ep.route;
          }
        }
      }
      result.push({
        id: `${file}:${call.line}:${i}`,
        file,
        symbol: enclosingSymbol(symbols, call.line)?.id,
        line: call.line,
        method: call.method,
        url: call.url,
        client: call.client,
        route: route?.id,
        external,
      });
    });
  }
  return result;
}
