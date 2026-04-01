- [x] Add toggle for 3 way outcomes in the config, disable pairs with 3 way outcomes like soccer games, skip the pair in the case it is 3 way.
- [x] Update Polytoken
    - [x] Logic stays exactly the same, but instead of posting to the V5 pairs, post to a subfolder of the github user using the folder. If the folder does not exist, create the folder with their username, and create a new csv file
         - for example, dplynn is my user. Create a new folder when i use polytoken, add my pairs that i generated to a csv file.
    - [x] When starting a new set of pairs, needs to check subfolders of pairs for duplicates. Reject any duplicate pairs from any subfolder
    - [x] When V5 launches, check all subfolders, append them to the master list of pairs. 
        - Clear all CSVs of pairs that were added to the master list so the algorithm does not have to recheck the same pairs multiple times.
- [x] Do a full re-check of the file structure. Clean up any connections that still exist. V1-4 should be in archived models and not connected to any other parts of the codebase. Only Polytoken and V5 should be connected. 


- Claude you are allowed to disagree with me, but have to require confirmation to change plans to a more optimal solution
