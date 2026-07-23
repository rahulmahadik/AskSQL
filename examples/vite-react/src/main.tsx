import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AskSqlChat, AskSqlBubble, HttpTransport } from '@asksql/react';

// Same-origin sidecar (the Express app that serves this bundle also mounts
// /asksql). A relative URL is the correct production pattern - no CORS.
const transport = new HttpTransport({ baseUrl: '/asksql' });

function App() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '12px 20px', borderBottom: '1px solid #e5e7eb' }}>
        <strong>AskSQL</strong> - full-page chat + floating bubble
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AskSqlChat
          transport={transport}
          answerSchemaQuestions
          suggestions={['How many customers are there?', 'How are the tables related?', 'Summarize this database']}
        />
      </div>
      {/* The same engine, as a floating chat-head you can drop on any page. */}
      <AskSqlBubble transport={transport} title="Ask the Shop DB" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
