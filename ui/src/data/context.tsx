import { createContext, useContext } from 'react';
import type { Model } from './model';

const ModelContext = createContext<Model | null>(null);

export const ModelProvider = ModelContext.Provider;

export function useModel(): Model {
  const model = useContext(ModelContext);
  if (!model) throw new Error('useModel() must be used inside <ModelProvider>');
  return model;
}
