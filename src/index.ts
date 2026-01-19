import { z } from 'zod';


export interface Env {
	ALLOWED_ORIGIN: string;
	GITHUB_TOKEN: string;
	GITHUB_OWNER: string;
	GITHUB_REPO: string;
	ACTIVE_WORKSHOP_SLUG: string;
}

interface ToolManifestEntry {
	id: string;
	author: string;
	name: string;
	description: string;
	model: string;
	url: string;
	uploadedAt: string;
}

interface GitHubFileResponse {
	content: string;
	sha: string;
}

// Response types
export type ValidationErrorResponse = { success: false; error: { issues: z.core.$ZodIssue[] } };
export type GeneralErrorResponse = { success: false; error: { message: string } };
export type ErrorResponse = ValidationErrorResponse | GeneralErrorResponse;
export type SuccessResponse = { success: true; filename: string; galleryUrl: string };
export type ApiResponse = SuccessResponse | ErrorResponse;

// Zod schema for input validation
const uploadInputSchema = z.object({
	toolName: z.string().min(1, 'Tool name is required').trim(),
	toolDescription: z.string().min(1, 'Description is required').trim(),
	nickname: z.string().min(1, 'Nickname is required').trim(),
	modelUsed: z.string().min(1, 'Model used is required').trim(),
	toolFile: z
		.instanceof(File, { message: 'A JavaScript file is required' })
		.refine((file) => file.name.endsWith('.js'), 'File must be a JavaScript file (.js)'),
});

export default {
	async fetch(request, env) {
		// CORS: single allowed origin (simpler, clearer)
		const origin = request.headers.get('Origin') || '';
		const corsHeaders = {
			'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		// Only allow POST requests
		if (request.method !== 'POST') {
			return jsonResponse<GeneralErrorResponse>({ success: false, error: { message: 'Method not allowed' } }, 405, corsHeaders);
		}

		// Enforce allowed origin for actual requests (protects simple requests without preflight)
		if (origin !== env.ALLOWED_ORIGIN) {
			return jsonResponse<GeneralErrorResponse>({ success: false, error: { message: 'Origin not allowed' } }, 403, corsHeaders);
		}

		try {
			// Parse multipart form data
			const formData = await request.formData();

			// Extract all form fields
			const formFields = {
				toolName: formData.get('toolName'),
				toolDescription: formData.get('toolDescription'),
				nickname: formData.get('nickname'),
				modelUsed: formData.get('modelUsed'),
				toolFile: formData.get('toolFile'),
			};

			// Validate whole form data with zod schema
			const validation = uploadInputSchema.safeParse(formFields);
			if (!validation.success) {
				return jsonResponse<ValidationErrorResponse>({ success: false, error: { issues: validation.error.issues } }, 400, corsHeaders);
			}

			// Use validated data from zod
			const { toolName, toolDescription, nickname, modelUsed, toolFile } = validation.data;

			// Read file content
			const fileContent = await toolFile.text();

			// Sanitize author name (using nickname)
			const sanitizedAuthor = sanitizeString(nickname, 20);

			// Sanitize filename (remove .js extension first)
			const originalFilename = toolFile.name.replace(/\.js$/, '');
			const sanitizedFilename = sanitizeString(originalFilename, 30);

			// Generate random 6-char string
			const randomString = generateRandomString(6);

			// Create final filename
			const finalFilename = `${sanitizedAuthor}-${sanitizedFilename}-${randomString}.js`;

			// Upload file to GitHub
			await uploadToGitHub(
				env.GITHUB_TOKEN,
				env.GITHUB_OWNER,
				env.GITHUB_REPO,
				`${env.ACTIVE_WORKSHOP_SLUG}/tools/${finalFilename}`,
				fileContent,
				`Add sketch by ${nickname}`
			);

			const manifestPath = `${env.ACTIVE_WORKSHOP_SLUG}/manifest.json`;

			// Update manifest.json
			await updateManifest(env.GITHUB_TOKEN, env.GITHUB_OWNER, env.GITHUB_REPO, manifestPath, {
				id: `${sanitizedAuthor}-${sanitizedFilename}-${randomString}`,
				author: nickname,
				name: toolName,
				description: toolDescription,
				model: modelUsed,
				url: `tools/${finalFilename}`,
				uploadedAt: new Date().toISOString(),
			});

			// Return success
			const galleryUrl = `https://${env.GITHUB_OWNER}.github.io/${env.GITHUB_REPO}/${env.ACTIVE_WORKSHOP_SLUG}/`;
			return jsonResponse<SuccessResponse>(
				{
					success: true,
					filename: finalFilename,
					galleryUrl: galleryUrl,
				},
				200,
				corsHeaders
			);
		} catch (error) {
			console.error('Upload error:', error);
			return jsonResponse<GeneralErrorResponse>(
				{
					success: false,
					error: { message: 'Internal server error. Please try again.' },
				},
				500,
				corsHeaders
			);
		}
	},
} satisfies ExportedHandler<Env>;

// Sanitize string for filename
function sanitizeString(str: string, maxLength: number) {
	return str
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.substring(0, maxLength);
}

// Generate random alphanumeric string
function generateRandomString(length: number) {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

// Base64 encoding helpers for Cloudflare Workers
function base64Encode(str: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(str);
	const binString = Array.from(data, (byte) => String.fromCodePoint(byte)).join('');
	return btoa(binString);
}

function base64Decode(str: string) {
	const binString = atob(str);
	const bytes = Uint8Array.from(binString, (char) => char.codePointAt(0)!);
	const decoder = new TextDecoder();
	return decoder.decode(bytes);
}

// Upload file to GitHub
async function uploadToGitHub(token: string, owner: string, repo: string, path: string, content: string, message: string) {
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

	const response = await fetch(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github.v3+json',
			'Content-Type': 'application/json',
			'User-Agent': 'P5-Tool-Uploader',
		},
		body: JSON.stringify({
			message: message,
			content: base64Encode(content),
			branch: 'main',
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`GitHub API error: ${response.status} - ${error}`);
	}

	return await response.json();
}

// Get file from GitHub
async function getFromGitHub(token: string, owner: string, repo: string, path: string): Promise<GitHubFileResponse | null> {
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github.v3+json',
			'User-Agent': 'P5-Tool-Uploader',
		},
	});

	if (!response.ok) {
		if (response.status === 404) {
			return null; // File doesn't exist
		}
		const error = await response.text();
		throw new Error(`GitHub API error: ${response.status} - ${error}`);
	}

	return await response.json();
}

// Update manifest.json
async function updateManifest(token: string, owner: string, repo: string, manifestPath: string, newTool: ToolManifestEntry) {
	// Get current manifest
	const currentManifest = await getFromGitHub(token, owner, repo, manifestPath);

	let manifest;
	let sha;

	if (currentManifest) {
		// Decode existing manifest
		const content = base64Decode(currentManifest.content);
		manifest = JSON.parse(content);
		sha = currentManifest.sha;
	} else {
		// Create new manifest
		manifest = { tools: [] };
		sha = undefined;
	}

	// Add new tool to beginning of array
	manifest.tools.unshift(newTool);

	// Upload updated manifest
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/${manifestPath}`;

	const response = await fetch(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github.v3+json',
			'Content-Type': 'application/json',
			'User-Agent': 'P5-Tool-Uploader',
		},
		body: JSON.stringify({
			message: 'Update manifest with new tool',
			content: base64Encode(JSON.stringify(manifest, null, 2)),
			sha: sha,
			branch: 'main',
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to update manifest: ${response.status} - ${error}`);
	}

	return await response.json();
}

// Helper to create JSON response
function jsonResponse<T extends ApiResponse>(data: T, status: number, headers: Record<string, string>) {
	return new Response(JSON.stringify(data), {
		status: status,
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
	});
}
