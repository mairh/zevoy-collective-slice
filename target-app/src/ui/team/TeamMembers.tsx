import { useEffect, useState } from "react";
import { listTeamMembers } from "../../api/team";
import { usePermission } from "../../auth/usePermission";
import type { User } from "../../types/user";
import { Panel } from "../common/Panel";

/** Company members and roles. Admin-only. */
export function TeamMembers() {
  const canManage = usePermission("team:manage");
  const [members, setMembers] = useState<User[]>([]);
  useEffect(() => {
    if (canManage) {
      listTeamMembers().then(setMembers);
    }
  }, [canManage]);
  if (!canManage) {
    return null;
  }
  return (
    <Panel title="Team">
      <ul>
        {members.map((member) => (
          <li key={member.id}>
            {member.name} · {member.role}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
