export type CircleType = 'family' | 'classmate';
export type Role = 'owner' | 'admin' | 'member';
export type Visibility = 'self' | 'circle';
export type PersonField =
  | 'name' | 'nickname' | 'gender' | 'birthOrder'
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
  wechatId?: string;
  photoFileId?: string;
  visibility: Partial<Record<PersonField, Visibility>>;
  claimedBy?: string;
  relationCount?: number;
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt?: number;
  /** Internal fingerprint for retrying a create request after a lost response. */
  createPayloadHash?: string;
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
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
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
}

export type CollectionName = keyof EntityMap;
