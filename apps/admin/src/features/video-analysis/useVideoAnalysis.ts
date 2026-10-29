import { useEffect, useState, useSyncExternalStore } from 'react'
import { VideoAnalysisController } from './videoAnalysisController.ts'

export function useVideoAnalysis() {
  const [controller] = useState(() => new VideoAnalysisController())
  // StrictMode cleanup invalidates the generation; effect setup reconnects the store.
  useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return { controller, state }
}
