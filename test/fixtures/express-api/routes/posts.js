const router = require('express').Router();
const auth = require('../middleware/auth');
const { listPosts, getPost, createPost } = require('../controllers/postsController');

router.get('/', listPosts);
router.get('/:postId', getPost);
router.post('/', auth, createPost);

module.exports = router;
