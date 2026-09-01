import type { User } from "../app-types";
import { GoalWorkspace } from "./goal-workspace";

export function GoalsPage({ user }: { user: User }) {
  return <GoalWorkspace user={user} pendingOnly={false} />;
}
