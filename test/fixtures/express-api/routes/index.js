const { Router } = require('express');
const usersRouter = require('./users');
const postsRouter = require('./posts');

const router = Router();

router.use('/users', usersRouter);
router.use('/posts', postsRouter);

module.exports = router;
