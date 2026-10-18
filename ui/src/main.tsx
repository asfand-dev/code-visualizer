import './styles/global.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ModelProvider } from './data/context';
import { loadReportData } from './data/load';
import { buildModel } from './data/model';

const container = document.getElementById('root')!;

loadReportData()
  .then((data) => {
    const model = buildModel(data);
    createRoot(container).render(
      <ModelProvider value={model}>
        <App />
      </ModelProvider>,
    );
  })
  .catch((error: unknown) => {
    console.error(error);
    container.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'boot';
    const title = document.createElement('h2');
    title.textContent = 'Could not load the report';
    const msg = document.createElement('p');
    msg.textContent = error instanceof Error ? error.message : String(error);
    box.append(title, msg);
    container.append(box);
  });
