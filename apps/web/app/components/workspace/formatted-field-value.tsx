"use client";

import { Fragment } from "react";
import { formatWorkspaceFieldValue } from "@/lib/workspace-cell-format";

type FormattedFieldValueProps = {
	value: unknown;
	fieldType?: string;
	mode?: "table" | "detail";
	className?: string;
};

function EmptyValue() {
	return <span style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>--</span>;
}

function FileEmbed({
	mediaType,
	url,
	label,
}: {
	mediaType: "image" | "video" | "audio" | "pdf";
	url: string;
	label: string;
}) {
	if (mediaType === "image") {
		return (
			<div className="mt-2 rounded-lg overflow-hidden border" style={{ borderColor: "var(--color-border)" }}>
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={url} alt={label} className="max-h-64 w-auto" />
			</div>
		);
	}
	if (mediaType === "video") {
		return (
			<video
				src={url}
				controls
				className="mt-2 w-full max-h-72 rounded-lg border"
				style={{ borderColor: "var(--color-border)", background: "#000" }}
			/>
		);
	}
	if (mediaType === "audio") {
		return <audio src={url} controls className="mt-2 w-full" />;
	}
	return (
		<iframe
			src={`${url}#toolbar=0&navpanes=0&scrollbar=1`}
			title={label}
			className="mt-2 w-full h-72 rounded-lg border"
			style={{ borderColor: "var(--color-border)", background: "white" }}
		/>
	);
}

function normalizeNewlines(text: string): string {
	return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
}

/**
 * Render a single line/segment with auto-detected formatting.
 * For text/richtext fields, uses heuristic detection so URLs, emails,
 * phone numbers are rendered as clickable links.
 */
function FormattedSegment({ text, fieldType }: { text: string; fieldType?: string }) {
	const trimmed = text.trim();
	if (!trimmed) {return <>{text}</>;}
	const detectType = !fieldType || fieldType === "text" || fieldType === "richtext" ? undefined : fieldType;
	const fmt = formatWorkspaceFieldValue(trimmed, detectType);

	if (fmt.kind === "link" && fmt.href) {
		// In heuristic mode (text/richtext), file-path detection is prone to false positives
		// on prose that happens to contain slashes and dotted words
		// (e.g. "Alternate/legacy domains: getgc.ai, gc.ai").
		// Only trust file links when the line has no spaces (i.e. a standalone path).
		if (!detectType && fmt.linkType === "file" && trimmed.includes(" ")) {
			return <>{fmt.text}</>;
		}
		const openInNewTab = fmt.linkType === "url" || fmt.linkType === "file";
		return (
			<a
				href={fmt.href}
				{...(openInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
				className="underline underline-offset-2"
				style={{ color: "var(--color-accent)" }}
				onClick={(e) => e.stopPropagation()}
			>
				{fmt.text}
			</a>
		);
	}

	if (fmt.kind === "number" || fmt.kind === "currency") {
		return <span className="tabular-nums">{fmt.text}</span>;
	}

	return <>{fmt.text}</>;
}

export function FormattedFieldValue({
	value,
	fieldType,
	mode = "table",
	className,
}: FormattedFieldValueProps) {
	const formatted = formatWorkspaceFieldValue(value, fieldType);
	const isTableMode = mode === "table";

	if (formatted.kind === "empty") {
		return <EmptyValue />;
	}

	const displayText = normalizeNewlines(formatted.text);
	const hasNewlines = displayText.includes("\n");

	if (hasNewlines) {
		const lines = displayText.split("\n");
		const containerClass = className ?? (isTableMode ? "block max-w-[300px] line-clamp-3" : "break-words");
		return (
			<span className={containerClass}>
				{lines.map((line, i) => (
					<Fragment key={i}>
						{i > 0 && <br />}
						<FormattedSegment text={line} fieldType={fieldType} />
					</Fragment>
				))}
			</span>
		);
	}

	// Single-line: full formatting with embeds
	const textClassName = className ?? (isTableMode ? "truncate block max-w-[300px]" : "break-words");

	if (formatted.kind === "link" && formatted.href) {
		const openInNewTab = formatted.linkType === "url" || formatted.linkType === "file";
		const canEmbedInModal = !isTableMode && !!formatted.embedUrl && !!formatted.mediaType;
		return (
			<div className={isTableMode ? "truncate block max-w-[300px]" : "w-full"}>
				<a
					href={formatted.href}
					{...(openInNewTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
					className={`underline underline-offset-2 ${isTableMode ? "truncate block" : ""}`}
					style={{ color: "var(--color-accent)" }}
					onClick={(e) => e.stopPropagation()}
				>
					{formatted.text}
				</a>
				{canEmbedInModal && (
					<FileEmbed
						mediaType={formatted.mediaType!}
						url={formatted.embedUrl!}
						label={formatted.text}
					/>
				)}
			</div>
		);
	}

	if (formatted.kind === "number" || formatted.kind === "currency") {
		return <span className={`tabular-nums ${textClassName}`}>{formatted.text}</span>;
	}

	return <span className={textClassName}>{displayText}</span>;
}
