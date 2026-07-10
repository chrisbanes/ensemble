import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RepoFinalizeSnapshot } from "@/generated/models";
import ConfirmDialog from "./ConfirmDialog";

interface FinalizeApprovalDialogProps {
  open: boolean;
  status: string;
  repos: RepoFinalizeSnapshot[];
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function approvalSignature(status: string, repos: RepoFinalizeSnapshot[]) {
  const pendingRepos = repos
    .filter((repo) => repo.status === "pending_approval")
    .map((repo) => ({
      approval_required: repo.approval_required,
      last_error: repo.last_error ?? null,
      mode: repo.mode,
      repo: repo.repo,
      status: repo.status,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({ status, pendingRepos });
}

export default function FinalizeApprovalDialog({
  open,
  status,
  repos,
  isPending,
  onConfirm,
  onCancel,
}: FinalizeApprovalDialogProps) {
  const pendingRepos = repos
    .filter((repo) => repo.status === "pending_approval")
    .sort((left, right) => left.repo.localeCompare(right.repo) || left.mode.localeCompare(right.mode));
  const currentSignature = approvalSignature(status, repos);
  const [capturedSignature, setCapturedSignature] = useState<string | null>(null);
  const eligible = status === "pending_approval" && pendingRepos.length > 0;
  const signatureMatches = capturedSignature === currentSignature;
  const canConfirm = open && eligible && signatureMatches && !isPending;
  const canConfirmRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setCapturedSignature(null);
      return;
    }
    setCapturedSignature((previous) => previous ?? currentSignature);
  }, [currentSignature, open]);

  useEffect(() => {
    if (open && capturedSignature !== null && (!eligible || !signatureMatches)) {
      onCancel();
    }
  }, [capturedSignature, eligible, onCancel, open, signatureMatches]);

  useLayoutEffect(() => {
    canConfirmRef.current = canConfirm;
  }, [canConfirm]);

  const targets = pendingRepos.map((repo) => `${repo.repo} (${repo.mode})`).join(", ");
  const message = targets
    ? `This may publish finalized workspace changes. Affected repositories: ${targets}.`
    : "This may publish finalized workspace changes. No pending repository details are available.";

  return (
    <ConfirmDialog
      open={open && eligible && signatureMatches}
      title="Approve finalize"
      message={message}
      confirmLabel="Approve finalize"
      confirmDisabled={!canConfirm}
      destructive={false}
      onConfirm={() => {
        if (canConfirmRef.current) onConfirm();
      }}
      onCancel={onCancel}
    />
  );
}
