#!/bin/bash

# Exit on error
set -e

APP_NAME="chartjs-mcp"
BRANCH_TO_DEPLOY="streamable-http"

echo "🚀 Deploying ChartJS MCP Server to Heroku app '$APP_NAME'..."

# Check for Heroku CLI
if ! command -v heroku &> /dev/null; then
    echo "❌ Heroku CLI not found. Please install it first."
    echo "   Visit: https://devcenter.heroku.com/articles/heroku-cli"
    exit 1
fi

# Login to Heroku (if not already logged in)
heroku whoami &> /dev/null || heroku login

# Create Procfile if it doesn't exist
if [ ! -f Procfile ]; then
    echo 'web: node dist/index.js --transport=streamable-http' > Procfile
    echo "✅ Created Procfile."
fi

# Check if app exists, create if not
if ! heroku apps:info -a $APP_NAME &> /dev/null; then
    echo "Creating Heroku app '$APP_NAME'..."
    heroku create $APP_NAME
else
    echo "✅ App '$APP_NAME' already exists."
fi

# Set Heroku remote to the app
heroku git:remote -a $APP_NAME

# Switch from container to buildpack deploys (if needed)
echo "🔄 Ensuring buildpack-based deployment..."
heroku stack:set heroku-24 -a $APP_NAME || true

# Ensure Node.js buildpack is set
heroku buildpacks:set heroku/nodejs -a $APP_NAME || true

# Clear Heroku build cache
echo "🧹 Clearing Heroku build cache..."
heroku config:set NODE_MODULES_CACHE=false -a $APP_NAME || true

# Commit Procfile if needed
if [ -n "$(git status --porcelain Procfile)" ]; then
    git add Procfile
    git commit -m "Add Procfile for Heroku deployment"
    echo "✅ Committed Procfile."
fi

# Sync package-lock.json with package.json
echo "📦 Regenerating package-lock.json..."
rm -rf node_modules package-lock.json
npm install

# Force add and commit package-lock.json
git add package-lock.json
if git diff --cached --quiet package-lock.json; then
    echo "📦 package-lock.json unchanged."
else
    git commit -m "Sync package-lock.json for Heroku deployment"
    echo "✅ Committed package-lock.json."
fi

# Push to origin first
echo "📤 Pushing to origin..."
git push origin $BRANCH_TO_DEPLOY || true

# Push to Heroku with force to ensure latest code
echo "📤 Pushing branch '$BRANCH_TO_DEPLOY' to Heroku..."
git push heroku $BRANCH_TO_DEPLOY:main --force

# Re-enable cache for future deploys
heroku config:set NODE_MODULES_CACHE=true -a $APP_NAME || true

echo ""
echo "✅ Deployment to Heroku app '$APP_NAME' complete!"
echo ""
echo "📋 Next steps:"
echo "   1. View logs:"
echo "      heroku logs --tail -a $APP_NAME"
echo ""
echo "   2. Open the app:"
echo "      heroku open -a $APP_NAME"
echo ""
echo "🔗 MCP endpoint: https://$APP_NAME.herokuapp.com/mcp"
