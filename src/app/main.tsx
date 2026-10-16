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
// Reuse the root if the entry module is evaluated again during a dev reload.
const container = document.getElementById('root')! as HTMLElement & { __obninskRoot?: ReactDOM.Root };
const root = (container.__obninskRoot ??= ReactDOM.createRoot(container));
root.render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    if (container.__obninskRoot === root) delete container.__obninskRoot;
  });
