import { OpenAIApi } from 'openai';
import { Octokit } from '@octokit/core';
import { Api } from '@octokit/plugin-rest-endpoint-methods/dist-types/types';
import { PaginateInterface } from '@octokit/plugin-paginate-rest';
import { context } from '@actions/github';
import { ISection } from '../services/comment-builder';
import { ISectionCreator } from '../interfaces/section-creator.interface';
import { Utils } from '../services/utils';
import { IConfig } from '../interfaces/config.interface';
import { IInputs } from '../interfaces/inputs.interface';
import { IIssueComment } from '../interfaces/issue-comment.interface';
import { encode, decode } from 'gpt-tokenizer';

export class SummariseCommentsSectionCreator implements ISectionCreator {
    isAddSection(inputs: IInputs, config: Partial<IConfig>) {
        return (
            inputs.addCommentSummarySection &&
            !!config.sections.commentSummary.prompt &&
            !!config.sections.commentSummary.title
        );
    }

    // Return a list of strings that have been chunked up to maxTokens.
    // maxTokens is the number of tokens to generate for the completion. We need to take into account
    // maxmimum allowable number of tokens that is allowed for the model and subtract
    // (prompt.length + maxTokens). Most models do 4096 so we will use that as a default.
    async generatePromptChunks(prompt_context: string, maxTokens: number) {
        const contextTokens = encode(prompt_context);
        const chunks = [];
        const MODEL_MAX_TOKENS = 4096;
        let chunk: number[] = [];

        const chunkSize = MODEL_MAX_TOKENS - maxTokens;

        for (const token of contextTokens) {
            if (chunk.length < chunkSize) {
                chunk.push(token);
            } else {
                chunks.push(chunk);
                chunk = [token];
            }
        }

        // Add the last chunk if it's not empty
        if (chunk.length > 0) {
            chunks.push(chunk);
        }

        return chunks.map((chunk) => decode(chunk));
    }

    async createSection(
        inputs: IInputs,
        openaiClient: OpenAIApi,
        octokit: Octokit &
            Api & {
                paginate: PaginateInterface;
            },
        config: Partial<IConfig>,
    ): Promise<ISection[]> {
        const issue = context.payload.issue;

        const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: issue.number,
        });

        const comments = response.data as IIssueComment[];
        const issueComments = comments
            .map((comment) => {
                return { body: comment?.body, created_at: comment?.created_at, author: comment?.user?.login };
            })
            .filter((comment) => comment.author !== 'github-actions[bot]');

        // I think we need to think about splitting up the prompt into chunks here. Each chunk should probably
        // include the title and body of the issue and then a chunk for each comment. We can then merge all the
        // summarization data into one message. Each data chunk is separated by ---
        const prompt = Utils.resolveTemplate(config?.sections?.commentSummary?.prompt, {
            issueTitle: issue.title,
            issueBody: issue.body,
            issueComments: '',
        });

        // length of prompt without issue comments
        const promptLength = encode(prompt).length;
        const messageParts = ['Merge all the summarization data into one message. Each data chunk is separated by ---'];
        const commentChunks = await this.generatePromptChunks(
            JSON.stringify(issueComments),
            inputs.maxTokens - promptLength,
        );

        for (const commentChunk of commentChunks) {
            const prompt = Utils.resolveTemplate(config?.sections?.commentSummary?.prompt, {
                issueTitle: issue.title,
                issueBody: issue.body,
                issueComments: commentChunk,
            });
            const result = (
                await openaiClient.createCompletion({
                    model: inputs.model,
                    prompt: prompt,
                    max_tokens: inputs.maxTokens,
                })
            ).data.choices[0].text;

            messageParts.push(result);
        }

        const message = (
            await openaiClient.createCompletion({
                model: inputs.model,
                prompt: messageParts.join('---'),
                max_tokens: inputs.maxTokens,
            })
        ).data.choices[0].text;

        return [
            {
                prompt: prompt,
                title: config.sections.commentSummary.title,
                description: message,
            },
        ];
    }
}
