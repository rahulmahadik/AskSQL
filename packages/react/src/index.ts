/**
 * @asksql/react - UI for AskSQL.
 *
 * Components: <AskSqlChat/> (full-page) and <AskSqlBubble/> (floating
 * chat-head). Headless: useAskSql. Transports: HttpTransport (sidecar) and
 * LocalTransport (in-browser engine).
 */

export { AskSqlChat, AskSqlBubble, SqlBlock, ResultTable } from './components.js';
export type { AskSqlChatProps, AskSqlBubbleProps, BubblePosition } from './components.js';
export { SchemaBrowser, type SchemaBrowserProps } from './SchemaBrowser.js';
export { ResultChart, isChartable } from './ResultChart.js';
export { inferChart, type ChartSpec, type ChartKind, type ChartSeries } from './chart.js';
export { SavedQueryStore, useSavedQueries, type SavedQuery, type KeyValueStore } from './saved.js';
export { useAskSql, type Turn, type TurnPhase, type UseAskSqlResult, type UseAskSqlOptions } from './useAskSql.js';
export {
  HttpTransport,
  LocalTransport,
  SseParser,
  TransportError,
  type Transport,
  type ChatEvent,
  type AskParams,
  type ConnectionSummary,
  type HttpTransportOptions,
} from './client.js';
export { formatCell, toCsv, type DisplayCell } from './format.js';
export { ensureStyles, ASKSQL_CSS } from './styles.js';
