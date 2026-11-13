// Подграф content: посты, цитаты и комментарии (порт 4002)
import { randomUUID } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { loadData, groupBy, countBy } from '../lib/data.js';
import { paginate, when } from '../lib/list.js';
import { startSubgraph } from '../lib/subgraph.js';
import { PORTS } from '../lib/config.js';

const { posts, comments } = loadData();

// ---- индексы в памяти ----
const postById = new Map();
const preparePost = (p) => {
  p._search = `${p.title} ${p.body} ${p.tags.join(' ')}`.toLowerCase();
  postById.set(p.id, p);
};
posts.forEach(preparePost);
for (const c of comments) c._search = c.body.toLowerCase();
const postsByAuthor = groupBy(posts, 'authorId');
const commentsByPost = groupBy(comments, 'postId');

const commentsCount = (p) => commentsByPost.get(p.id)?.length ?? 0;
const postSort = { TITLE: (p) => p.title, LIKES: (p) => p.likes, VIEWS: (p) => p.views, COMMENTS: commentsCount };

const badInput = (msg) => new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
function getPost(id) {
  const post = postById.get(id);
  if (!post) throw new GraphQLError(`Пост ${id} не найден`, { extensions: { code: 'NOT_FOUND' } });
  return post;
}

function listPosts(list, { search, filter = {}, sort, dir, page, pageSize }) {
  return paginate(list, {
    search,
    filters: [
      ...when(filter.source, (p) => p.source === filter.source),
      ...when(filter.kind, (p) => p.kind === filter.kind),
      ...when(filter.tag, (p) => p.tags.includes(filter.tag)),
      ...when(filter.authorId, (p) => p.authorId === filter.authorId),
      ...when(filter.minLikes, (p) => p.likes >= filter.minLikes),
    ],
    sortKey: postSort[sort],
    dir,
    page,
    pageSize,
  });
}

// Ссылка на сущность из другого подграфа: шлюз сам достанет остальные поля пользователя
const userRef = (id) => (id ? { __typename: 'User', id } : null);

const resolvers = {
  Query: {
    posts: (_, args) => listPosts(posts, args),
    post: (_, { id }) => postById.get(id),
    comments: (_, { search, postId, page, pageSize }) =>
      paginate(postId ? commentsByPost.get(postId) ?? [] : comments, { search, page, pageSize }),
    tags: (_, { limit }) => countBy(posts.flatMap((p) => p.tags.map((tag) => ({ tag }))), 'tag').slice(0, limit),
    contentStats: () => ({}),
  },
  ContentStats: {
    posts: () => posts.length,
    comments: () => comments.length,
    bySource: () => countBy([...posts, ...comments], 'source'),
    byKind: () => countBy(posts, 'kind'),
  },
  Mutation: {
    createPost: (_, { input }) => {
      const title = input.title.trim();
      const body = input.body.trim();
      if (!title || title.length > 200) throw badInput('Заголовок: от 1 до 200 символов');
      if (!body || body.length > 5000) throw badInput('Текст: от 1 до 5000 символов');
      const post = { id: `local-${randomUUID().slice(0, 8)}`, source: 'LOCAL', kind: 'POST', title, body, tags: input.tags.map((t) => t.trim()).filter(Boolean), likes: 0, views: 0, authorId: input.authorId };
      preparePost(post);
      posts.unshift(post);
      if (!postsByAuthor.has(post.authorId)) postsByAuthor.set(post.authorId, []);
      postsByAuthor.get(post.authorId).unshift(post);
      return post;
    },
    likePost: (_, { id }) => {
      const post = getPost(id);
      post.likes++;
      return post;
    },
    deletePost: (_, { id }) => {
      const post = postById.get(id);
      if (!post) return false;
      postById.delete(id);
      posts.splice(posts.indexOf(post), 1);
      const own = postsByAuthor.get(post.authorId);
      own?.splice(own.indexOf(post), 1);
      return true;
    },
    addComment: (_, { postId, body, authorId }) => {
      getPost(postId);
      if (!body.trim() || body.length > 2000) throw badInput('Комментарий: от 1 до 2000 символов');
      const comment = { id: `local-${randomUUID().slice(0, 8)}`, source: 'LOCAL', postId, authorId: authorId ?? null, authorName: authorId ? null : 'Гость', body: body.trim(), likes: 0 };
      comment._search = comment.body.toLowerCase();
      comments.unshift(comment);
      if (!commentsByPost.has(postId)) commentsByPost.set(postId, []);
      commentsByPost.get(postId).unshift(comment);
      return comment;
    },
  },
  Post: {
    __resolveReference: ({ id }) => postById.get(id),
    author: (p) => userRef(p.authorId),
    commentsCount,
    comments: (p, { page, pageSize }) => paginate(commentsByPost.get(p.id) ?? [], { page, pageSize }),
  },
  Comment: {
    author: (c) => userRef(c.authorId),
    post: (c) => postById.get(c.postId),
  },
  User: {
    // users-подграф передаёт только { id }, остальные поля пользователя добавляет content
    __resolveReference: ({ id }) => ({ id }),
    postsCount: ({ id }) => postsByAuthor.get(id)?.length ?? 0,
    posts: ({ id }, args) => listPosts(postsByAuthor.get(id) ?? [], args),
  },
};

console.log(`[content] загружено: ${posts.length} постов, ${comments.length} комментариев`);
await startSubgraph({ name: 'content', port: PORTS.content, resolvers });
