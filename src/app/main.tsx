import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/manrope';
import './styles.css';
import { App } from './App.js';

class AppBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  override render() {
    return this.state.error ? (
      <main className="fatal-screen">
        <h1>Не удалось открыть карту</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>Перезагрузить</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
