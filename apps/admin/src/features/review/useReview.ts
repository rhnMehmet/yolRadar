import { useEffect, useState, useSyncExternalStore } from 'react'
import { ReviewController } from './reviewController.ts'
export function useReview(){const [controller]=useState(()=>new ReviewController());useEffect(()=>()=>controller.dispose(),[controller]);const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);return {controller,state}}
