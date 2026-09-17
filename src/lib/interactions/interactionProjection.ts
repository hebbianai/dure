type ParticipantRef = string;

interface InteractionAuthorityProjection {
	workspaceId: string;
	tenantRef?: string;
}

export interface InteractionTargetProjection {
	authority: InteractionAuthorityProjection;
	runId: string;
	taskId: string;
	dispatchId: string;
	generation: number;
}

export interface InteractionAudienceGrant {
	membershipRef: string;
	participant: ParticipantRef;
	roles: string[];
}

interface InteractionCommonProjection {
	id: string;
	target: InteractionTargetProjection;
	revision: number;
	title: string;
	descriptionMarkdown: string;
	author: ParticipantRef;
	audience: { grants: InteractionAudienceGrant[] };
	createdAtMs: number;
}

interface SelectOptionProjection {
	id: string;
	label: string;
	descriptionMarkdown?: string;
}

export type DecisionResponseProjection =
	| { kind: "text"; minBytes: number; maxBytes: number }
	| {
			kind: "select";
			options: SelectOptionProjection[];
			minSelections: number;
			maxSelections: number;
	  };

export type DecisionAnswerProjection =
	| { kind: "text"; value: string }
	| { kind: "select"; optionIds: string[] };

export type InteractionProjection =
	| {
			kind: "message";
			common: InteractionCommonProjection;
			purpose: "update" | "completion_report";
	  }
	| {
			kind: "decision";
			common: InteractionCommonProjection;
			response: DecisionResponseProjection;
			state: "open" | "answered";
			answer?: DecisionAnswerProjection;
	  };
