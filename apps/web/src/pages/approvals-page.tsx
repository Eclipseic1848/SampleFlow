import type { User } from "../app-types";
import { GoalWorkspace } from "./goal-workspace";

export function ApprovalsPage({ user }: { user: User }) {
  return <GoalWorkspace user={user} pendingOnly />;
}
