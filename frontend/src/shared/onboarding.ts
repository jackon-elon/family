import type {
  ApplicationView,
  OnboardingPreview,
  PersonView,
  UserProfile,
} from "../types";

/** An account number match proposes a record; it never grants family access. */
export function invitationCanApply(
  preview: OnboardingPreview | null,
  profile: UserProfile | null,
): boolean {
  if (!preview || !profile?.name || !profile.city || !profile.birthday)
    return false;
  return (
    preview.match.status === "none" ||
    (preview.match.status === "unique" &&
      !!preview.match.person &&
      preview.match.confirmed === true)
  );
}

export function matchedReviewPerson(
  application: ApplicationView,
  people: PersonView[],
): PersonView | undefined {
  const match = application.phoneMatch;
  if (match?.status !== "unique") return undefined;
  return people.find(
    (person) =>
      person.id === match.personId &&
      !person.isClaimed &&
      person.updatedAt === match.personUpdatedAt,
  );
}

export function reviewMatchError(
  application: ApplicationView,
  people: PersonView[],
): string {
  const match = application.phoneMatch;
  if (!match || match.status === "none") return "";
  if (match.status === "unique" && match.confirmed === false)
    return "家人资料有更新，请让申请人重新打开邀请、确认本人资料后再批准。";
  if (match.status === "unique")
    return matchedReviewPerson(application, people)
      ? ""
      : "已有资料发生变化，请关闭后刷新申请，再确认加入。";
  return (
    match.message ||
    "这个手机号对应的家人资料需要核对，请先修正资料后再确认加入。"
  );
}
