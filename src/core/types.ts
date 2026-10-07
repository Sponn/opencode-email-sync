export interface Route { instanceId: string; projectId: string; directory: string; sessionId: string }
export interface Answer { route: Route; turnId: string; text: string; project: string; title: string }
export interface SessionRecord { route: Route; project: string; title: string; baseline: string[] | null; deleted: boolean }
export interface Delivery { id: string; route: Route; recipient: string; text: string; project: string; title: string; messageId: string; references?: string; control: boolean; attempts: number }
export interface PromptJob { id: string; route: Route; text: string; sender: string; messageId: string; owner: string | null; status: string }
export interface Thread { route: Route; recipient: string; project: string; title: string; messageId: string }
export function routeKey(route: Route): string { return JSON.stringify([route.instanceId, route.projectId, route.directory, route.sessionId]) }
