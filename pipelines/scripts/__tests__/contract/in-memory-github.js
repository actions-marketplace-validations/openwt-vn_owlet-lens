'use strict';

/**
 * In-memory FakeOctokit for contract testing GitHubReviewProvider.
 * Models REST + GraphQL state in plain JS Maps; exposes mutation getters
 * for assertion (`fake.posts`, `fake.replies`, `fake.statusPatches`,
 * `fake.summaryUpdates`, `fake.summaryCreates`).
 *
 * Not a real GitHub API — only models the surface the provider touches.
 */
class InMemoryGitHub {
  constructor({ owner = 'o', repo = 'r', prNumber = 1, headSha = 'sha1' } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.prNumber = prNumber;
    this.headSha = headSha;

    /** @type {Array<{filename:string,status:string,patch:string,previous_filename?:string}>} */
    this.files = [];
    /** @type {Map<number, {id:number,path:string,line:number,body:string,user:{login:string},created_at:string}>} */
    this.reviewComments = new Map();
    /** @type {Map<string, {id:string,isResolved:boolean,commentIds:Set<number>}>} */
    this.threads = new Map();
    /** @type {Map<number, {id:number,body:string,user:{login:string}}>} */
    this.issueComments = new Map();

    this._nextCommentId = 1;
    this._nextThreadId = 1;
    this._nextIssueCommentId = 100;

    this.posts = [];
    this.replies = [];
    this.statusPatches = [];
    this.summaryUpdates = [];
    this.summaryCreates = [];
  }

  setFiles(files) { this.files = files; }

  /**
   * Seed a review thread directly (bypasses postThread). Useful for setting
   * up "existing bot threads" the provider's listThreads should observe.
   */
  seedThread({ path, line, body, isBot = true, isResolved = false, createdAt }) {
    const cid = this._nextCommentId++;
    const tid = `T${this._nextThreadId++}`;
    const login = isBot ? 'ai-bot' : 'dev';
    this.reviewComments.set(cid, {
      id: cid, path, line, body, user: { login },
      created_at: createdAt ?? new Date(Date.now() + cid * 1000).toISOString(),
    });
    this.threads.set(tid, { id: tid, isResolved, commentIds: new Set([cid]) });
    return { threadId: tid, commentId: cid };
  }

  /** Append a comment to an existing seeded thread. */
  seedReplyOn(threadId, { body, isBot = true, createdAt } = {}) {
    const t = this.threads.get(threadId);
    if (!t) throw new Error(`unknown thread ${threadId}`);
    const cid = this._nextCommentId++;
    this.reviewComments.set(cid, {
      id: cid, path: '', line: 0, body, user: { login: isBot ? 'ai-bot' : 'dev' },
      created_at: createdAt ?? new Date(Date.now() + cid * 1000).toISOString(),
    });
    t.commentIds.add(cid);
    return { commentId: cid };
  }

  /** Build a stub Octokit-shaped REST client. */
  restClient() {
    const self = this;
    return {
      pulls: {
        get: async () => ({
          data: {
            number: self.prNumber, head: { ref: 'h', sha: self.headSha },
            base: { ref: 'b', sha: 'sha0' }, title: 'PR title',
            user: { login: 'author', email: 'a@x' }, html_url: `https://gh/${self.owner}/${self.repo}/pull/${self.prNumber}`,
          },
        }),
        listFiles: async () => ({ data: self.files.slice() }),
        createReviewComment: async ({ body, path, line }) => {
          const cid = self._nextCommentId++;
          const tid = `T${self._nextThreadId++}`;
          self.reviewComments.set(cid, {
            id: cid, path, line, body, user: { login: 'ai-bot' },
            created_at: new Date(Date.now() + cid * 1000).toISOString(),
          });
          self.threads.set(tid, { id: tid, isResolved: false, commentIds: new Set([cid]) });
          self.posts.push({ commentId: cid, threadId: tid, body, path, line });
          return { data: { id: cid } };
        },
        listReviewComments: async () => ({ data: [...self.reviewComments.values()] }),
      },
      issues: {
        listComments: async () => ({ data: [...self.issueComments.values()] }),
        updateComment: async ({ comment_id, body }) => {
          const c = self.issueComments.get(comment_id);
          if (!c) {
            const e = new Error(`Not Found`); e.status = 404; throw e;
          }
          c.body = body;
          self.summaryUpdates.push({ commentId: comment_id, body });
          return { data: { id: comment_id } };
        },
        createComment: async ({ body }) => {
          const cid = self._nextIssueCommentId++;
          self.issueComments.set(cid, { id: cid, body, user: { login: 'ai-bot' } });
          self.summaryCreates.push({ commentId: cid, body });
          return { data: { id: cid } };
        },
      },
    };
  }

  /** Build a GraphQL stub matching the queries the provider issues. */
  graphqlClient() {
    const self = this;
    return async (query, vars) => {
      if (query.includes('reviewThreads(first:50')) {
        const nodes = [...self.threads.values()].map((t) => ({
          id: t.id,
          isResolved: t.isResolved,
          comments: {
            nodes: [...t.commentIds].map((cid) => ({ databaseId: cid })),
            pageInfo: { hasNextPage: false },
          },
        }));
        return {
          repository: { pullRequest: { reviewThreads: {
            nodes, pageInfo: { hasNextPage: false, endCursor: null },
          } } },
        };
      }
      if (query.includes('addPullRequestReviewThreadReply')) {
        const t = self.threads.get(vars.threadId);
        if (!t) throw new Error(`unknown thread ${vars.threadId}`);
        const cid = self._nextCommentId++;
        self.reviewComments.set(cid, {
          id: cid, path: '', line: 0, body: vars.body, user: { login: 'ai-bot' },
          created_at: new Date(Date.now() + cid * 1000).toISOString(),
        });
        t.commentIds.add(cid);
        self.replies.push({ threadId: vars.threadId, body: vars.body, commentId: cid });
        return { addPullRequestReviewThreadReply: { comment: { databaseId: cid } } };
      }
      if (query.includes('unresolveReviewThread')) {
        const t = self.threads.get(vars.id);
        if (t) t.isResolved = false;
        self.statusPatches.push({ threadId: vars.id, resolved: false });
        return { unresolveReviewThread: { thread: { id: vars.id } } };
      }
      if (query.includes('resolveReviewThread')) {
        const t = self.threads.get(vars.id);
        if (t) t.isResolved = true;
        self.statusPatches.push({ threadId: vars.id, resolved: true });
        return { resolveReviewThread: { thread: { id: vars.id } } };
      }
      throw new Error(`InMemoryGitHub: unhandled GraphQL query: ${query.slice(0, 80)}`);
    };
  }
}

module.exports = { InMemoryGitHub };
