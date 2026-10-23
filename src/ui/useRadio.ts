import { useSyncExternalStore } from 'react'
import { store, type RadioState } from './store.ts'

/** The connection state, re-rendering on every change; actions are on `store`. */
export function useRadio(): RadioState {
  return useSyncExternalStore(store.subscribe, store.getState)
}
