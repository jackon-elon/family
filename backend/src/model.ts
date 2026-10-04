export type CircleType = 'family' | 'classmate';
export type Role = 'owner' | 'admin' | 'member';
export type Visibility = 'self' | 'circle';
export interface Birthday {
  calendar: 'solar' | 'lunar';
  month: number;
  day: number;
  /** Optional: members may share a birthday without disclosing their age. */
  year?: number;
  /** A lunar leap-month birthday is distinct from the ordinary month. */
  leapMonth?: boolean;
}
export interface JoinProfile {
  country: string;
  province?: string;
  city: string;
  latitude?: number;
  longitude?: number;
  birthday: Birthday;
}
export type PersonField =
  | 'name' | 'nickname' | 'gender' | 'birthOrder' | 'birthday'
  | 'country' | 'province' | 'city' | 'latitude' | 'longitude' | 'status' | 'school'
  | 'industry' | 'occupation' | 'bio' | 'phone' | 'wechatId' | 'photoFileId';

export interface Circle {
  id: string;
  type: CircleType;
  name: string;
  mode: 'private' | 'shared';
  ownerId: string;
  /** Original creator, kept stable when ownership changes. */
  createdBy?: string;
  school?: string;
  cohort?: string;
  className?: string;
  createdAt: number;
  updatedAt: number;
  /** Internal fingerprint for retrying a create request after a lost response. */
  createPayloadHash?: string;
  /** Pending ownership handoff; never included in public circle views. */
  ownerTransfer?: {
    id: string;
    targetMemberId: string;
    targetJoinedAt: number;
    createdAt: number;
    expiresAt: number;
  };
}

export interface Member {
  id: string;
  circleId: string;
  userId: string;
  name?: string;
  role: Role;
  status: 'active' | 'left' | 'removed';
  personId?: string;
  joinedAt: number;
  endedAt?: number;
}

export interface Person {
  id: string;
  circleId: string;
  name: string;
  nickname?: string;
  gender?: 'male' | 'female' | 'unknown';
  birthOrder?: number;
  birthday?: Birthday;
  country?: string;
  province?: string;
  city?: string;
  /** Coarse city representative point, rounded to 0.1 degree; never GPS/home location. */
  latitude?: number;
  longitude?: number;
  status?: string;
  school?: string;
  industry?: string;
  occupation?: string;
  bio?: string;
  phone?: string;
  /** Administrator-entered match key; never included in a circle-visible person view. */
  matchPhone?: string;
  wechatId?: string;
  photoFileId?: string;
  /** Per-record administrator corrections. An account edit to a field retires
   * that field's correction, without letting one record edit another. */
  profileOverrides?: Partial<Record<PersonField, {baseRevision: number; value: unknown}>>;
  visibility: Partial<Record<PersonField, Visibility>>;
  claimedBy?: string;
  relationCount?: number;
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt?: number;
  /** Internal fingerprint for retrying a create request after a lost response. */
  createPayloadHash?: string;
}

/** One unclaimed card per phone in a circle, guarded by a deterministic ID. */
export interface PhoneMatch {
  id: string;
  circleId: string;
  personId: string;
  phone: string;
  createdAt: number;
}

/** Phone number obtained by a cloud-only WeChat code exchange. */
export interface PhoneIdentity {
  id: string;
  userId: string;
  phone: string;
  verifiedAt: number;
}

/** One account-owned profile shared by every claimed person in every circle. */
export interface UserProfile extends Partial<Pick<Person,
  'name' | 'nickname' | 'gender' | 'birthday' | 'country' | 'province' | 'city' |
  'latitude' | 'longitude' | 'status' | 'school' | 'industry' | 'occupation' |
  'bio' | 'phone' | 'wechatId' | 'photoFileId'>> {
  id: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  /** Empty profile created after linking a pre-recorded card; its missing
   * fields must not hide that card or import card data into the account. */
  cardFallback?: boolean;
  /** Incremented whenever the account owner edits a field, including when
   * changing it back, so older per-record corrections cannot reappear. */
  fieldRevisions?: Partial<Record<PersonField, number>>;
  clearedFields?: PersonField[];
}

export interface Relation {
  id: string;
  circleId: string;
  from: string;
  to: string;
  type: 'parent' | 'spouse' | 'sibling';
  olderId?: string;
  createdBy: string;
  createdAt: number;
}

export interface RelationChange {
  removeRelationId?: string;
  relation?: Pick<Relation, 'from' | 'to' | 'type' | 'olderId'>;
}

export interface Invite {
  id: string;
  circleId: string;
  tokenHash: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  usedAt?: number;
  usedBy?: string;
}

export interface Application {
  id: string;
  circleId: string;
  inviteId: string;
  userId: string;
  name: string;
  /** Self-entered details, reviewed before membership is granted. Legacy rows lack this. */
  profile?: JoinProfile;
  /** Hash of the account profile at submission, for detecting later edits during review. */
  profileVersion?: string;
  note?: string;
  /** Legacy field only. Join approval never binds a person card from it. */
  claimPersonId?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
}

export interface Delegation {
  id: string;
  circleId: string;
  personId: string;
  ownerUserId: string;
  adminUserId: string;
  fields: PersonField[];
  createdAt: number;
  revokedAt?: number;
}

export interface Suggestion {
  id: string;
  circleId: string;
  createdBy: string;
  personId?: string;
  type: 'person' | 'relation' | 'invite';
  message: string;
  relationChange?: RelationChange;
  /** Snapshot guard so approval cannot silently replace a newer relation. */
  expectedRelationHash?: string;
  status: 'pending' | 'accepted' | 'handled' | 'rejected';
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface ClaimRequest {
  id: string;
  circleId: string;
  personId: string;
  userId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
}

export interface AuditEvent {
  id: string;
  circleId: string;
  actorId: string;
  type: string;
  targetId: string;
  at: number;
  details?: Record<string, unknown>;
}

export interface PhotoUploadBudget {
  id: string;
  windowStartedAt: number;
  count: number;
  reservationIds: string[];
}

/** A viewer's private note; never part of a person or shared account profile. */
export interface PersonRemark {
  id: string;
  circleId: string;
  personId: string;
  userId: string;
  memberJoinedAt: number;
  personCreatedAt: number;
  remark: string;
  updatedAt: number;
}

export interface EntityMap {
  circles: Circle;
  members: Member;
  persons: Person;
  relations: Relation;
  invites: Invite;
  applications: Application;
  delegations: Delegation;
  suggestions: Suggestion;
  claimRequests: ClaimRequest;
  audit: AuditEvent;
  photoUploadBudgets: PhotoUploadBudget;
  phoneMatches: PhoneMatch;
  phoneIdentities: PhoneIdentity;
  userProfiles: UserProfile;
  personRemarks: PersonRemark;
}

export type CollectionName = keyof EntityMap;
