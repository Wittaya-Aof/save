# Archived local launchers

These copies are historical only. Their filenames end in `.disabled` and they are not used by npm start, the Docker image, or VPS staging.

They were copied from the retired local project and may reference its paths or port 3000. Do not restore or launch them as part of the cloud deployment. The new local application is started with `npm start` from the new project, with PORT=3002 in its private .env. The online app is managed through Docker as documented in ../VPS-DEPLOYMENT.md.

No existing Windows startup shortcut, scheduled task, or process associated with the original folder was modified by archiving these copies.
