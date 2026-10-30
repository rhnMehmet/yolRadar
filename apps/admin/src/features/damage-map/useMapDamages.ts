import { useEffect,useState,useSyncExternalStore } from 'react'
import { MapController } from './mapController.ts'
export function useMapDamages(){
  const [controller]=useState(()=>new MapController())
  useEffect(()=>()=>controller.dispose(),[controller])
  return {controller,state:useSyncExternalStore(controller.subscribe,controller.getSnapshot)}
}
