import type {
  Person,
  Circle,
  Relation,
  Birthday,
  UserProfile,
} from "../../backend/src/model";
export type { Relation, Birthday, UserProfile };
export type PersonView = Person & {
  isSelf?: boolean;
  isClaimed?: boolean;
  hasPhoto?: boolean;
  photoUrl?: string;
  profileComplete?: boolean;
};
/** Fields used for browsing, without account, claim or administrator metadata. */
export type BrowsePerson = Pick<
  PersonView,
  | "id"
  | "circleId"
  | "name"
  | "nickname"
  | "gender"
  | "birthOrder"
  | "birthday"
  | "country"
  | "province"
  | "city"
  | "latitude"
  | "longitude"
  | "status"
  | "school"
  | "industry"
  | "occupation"
  | "bio"
  | "phone"
  | "wechatId"
  | "hasPhoto"
  | "photoUrl"
  | "profileComplete"
  | "isSelf"
>;
export interface FamilyBrowseData {
  circle: { id: string; name: string; role?: "owner" | "admin" | "member" };
  people: BrowsePerson[];
  relations: Array<Pick<Relation, "id" | "from" | "to" | "type" | "olderId">>;
  remarks: Record<string, string>;
  ownerTransfer?: OwnerTransfer | null;
}
export interface GuestFamilyData {
  family: { id: string; name: string; type: "family"; personCount: number };
  persons: BrowsePerson[];
  relations: FamilyBrowseData["relations"];
  birthdays?: GuestBirthdays;
  serverTime?: number;
  /** Local receipt time anchors midnight refresh without trusting device timezone. */
  receivedAt: number;
  expiresAt: number;
}
export interface GuestBirthdays {
  events: BirthdayEvent[];
  asOf: string;
  refreshAt: number;
  error?: string;
}
export type CircleView = Circle & {
  role: "owner" | "admin" | "member";
  personCount: number;
  memberCount: number;
};
export interface User {
  id: string;
  phone: string;
  phoneVerified: boolean;
  canCreateFamily?: false;
  access: "member" | "invited";
  invitation?: {
    id: string;
    circleId: string;
    circleName: string;
    status: "profile-required" | "pending";
    expiresAt: number;
  };
}
export interface LoginSession {
  id: string;
  isCurrent: boolean;
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}
export interface MemberView {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  personId?: string;
  isSelf: boolean;
}
export interface OwnerTransfer {
  id: string;
  targetMemberId: string;
  targetName: string;
  expiresAt: number;
  isTarget: boolean;
  isOwner: boolean;
}
export interface CircleData {
  circle: CircleView;
  people: PersonView[];
  relations: Relation[];
  remarks: Record<string, string>;
  members: MemberView[];
  ownerTransfer: OwnerTransfer | null;
}
export interface BirthdayEvent {
  personId: string;
  personName: string;
  circleId: string;
  circleName: string;
  date: string;
  daysUntil: number;
  birthdayText: string;
  birthdayCalendar: "solar" | "lunar";
}
export interface InviteView {
  id: string;
  token?: string;
  expiresAt: number;
  status: string;
  createdAt?: number;
}
export interface ApplicationView {
  id: string;
  name: string;
  circleId: string;
  circleName?: string;
  note?: string;
  profile?: { country: string; city: string; birthday: Birthday };
  status: string;
  reviewToken?: string;
  profileIncomplete?: boolean;
  inviteStatus?: string;
  canEnter?: boolean;
  loginPhone?: string;
  phoneMatch?: {
    status: PhoneMatchStatus;
    confirmed?: boolean;
    personId?: string;
    personUpdatedAt?: number;
    message?: string;
  };
}
export type PhoneMatchStatus =
  "none" | "unique" | "conflict" | "bound" | "verification-required";
export interface OnboardingPreview {
  loginPhone: string;
  profileVersion: string;
  match: {
    status: PhoneMatchStatus;
    confirmed?: boolean;
    message?: string;
    person?: {
      id: string;
      updatedAt: number;
      profile: Partial<UserProfile> & { hasPhoto?: boolean };
    };
  };
}
